// dsh --profile acp を Orca supervised worker / Commander にするブリッジ。
// **既定の launcher は dsh-tui-launcher.mjs**(dsh-tui を起動するだけで readiness を通せる実測あり)。
// ここを使うのは ACP 側の機能が要るとき(権限要求の機械応答 / MCP 注入 / マルチターン / モデル指定)。
//
// 背景(実機で確認した事実):
//   dsh --profile acp は ACP(Agent Client Protocol)の JSON-RPC stdio サーバー。
//   Orca のターミナル注入は素のテキストなので、ACP に直接向けると
//   {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}
//   が pane に出てタスクが始まらない(実測)。なので「注入テキストを ACP の
//   session/prompt に載せ直す」このブリッジが要る。
//
// headless 版(dsh-headless-worker.mjs)との違い:
//   * 同一セッションでマルチターン(後続の send が 2 ターン目以降になる)
//   * session/request_permission を機械が答える(承認待ちで止まらない)
//   * session/cancel / session/close で後片付けできる
//   * モデルと reasoning_effort を session/set_config_option で選べる
//     (worker-start の --model / --effort は dsh では使えないため)
//
// 使い方(Orca のエージェント起動コマンドとして設定する):
//   node C:\...\orca-mcp\scripts\dsh-acp-worker.mjs
//
// 環境変数(すべて省略可):
//   DSH_ACP_PROFILE      起動するプロファイル(既定 acp)
//   DSH_ACP_PERMISSION   allow_once(既定)/ allow_always / reject
//   DSH_ACP_MODEL        "provider/model" を指定して session/set_config_option で焼く
//   DSH_ACP_EFFORT       off / low / high / max
//   DSH_ACP_MCP          ACP の mcpServers 配列を JSON で(例: orca-mcp を注入)
//   DSH_ACP_IDLE_EXIT_MS ターン後に次の注入を待つ上限(既定 30 分)
//   DSH_ACP_MAX_TURNS    1 プロセスで回すターン上限(既定 40)
//   DSH_ACP_QUICK_FIRST_MS 起動直後の注入 probe(既定 1.5 秒)
//   DSH_ACP_LOOKUP_MS    dispatch 照合の上限(既定 180 秒。worker の dispatch は readiness
//                        失敗後 ~110 秒で見える。短くすると worker pane が対話に落ちる)
//   DSH_ACP_TUI_BIN / DSH_ACP_TUI_ARGS 対話フォールバックで起動する dsh-tui と引数
//   DSH_ACP_NO_FALLBACK  =1 で対話フォールバック無効(タスク取得失敗で終了)
//   DSH_ACP_LOG          ログファイル(既定 <tmp>/dsh-acp-worker.log)
//
// 対話で dsh-tui を使いたい人はブリッジを通さない `dst .`(agentCmdOverrides に引っかからない)。
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const PROFILE = process.env.DSH_ACP_PROFILE ?? "acp";
const PERMISSION = process.env.DSH_ACP_PERMISSION ?? "allow_once";
const IDLE_EXIT_MS = Number(process.env.DSH_ACP_IDLE_EXIT_MS ?? 30 * 60_000);
const MAX_TURNS = Number(process.env.DSH_ACP_MAX_TURNS ?? 40);
const FIRST_CHUNK_MS = Number(process.env.DSH_ACP_FIRST_CHUNK_MS ?? 20_000);
// worker 起動(Orca が launch token を注入する)ではない pane では、注入を待たずに
// dsh-tui へ素通しする。対話で dsh-tui を使いたい場合の使い分け(README 参照)。
const QUICK_FIRST_MS = Number(process.env.DSH_ACP_QUICK_FIRST_MS ?? 1_500);
// dispatch 照合の上限。worker の dispatch が assignee 付きで「見える」のは readiness が
// 失敗した後(pane 起動から ~110 秒)。ここを短くすると worker pane が対話フォールバックに
// 落ちる(20 秒 / 120 秒で実測デグレ)。対話で dsh-tui を使いたい人の正解は `dst .`(README 参照)。
const LOOKUP_MS = Number(process.env.DSH_ACP_LOOKUP_MS ?? 180_000);
const NO_FALLBACK = process.env.DSH_ACP_NO_FALLBACK === "1";
const TUI_BIN = process.env.DSH_ACP_TUI_BIN ?? "";
const TUI_ARGS = (process.env.DSH_ACP_TUI_ARGS ?? ".").split(" ").filter(Boolean);
const LAUNCH_TOKEN = process.env.ORCA_AGENT_LAUNCH_TOKEN ?? "";
const IDLE_MS = Number(process.env.DSH_ACP_IDLE_MS ?? 4_000);
const MAX_MS = Number(process.env.DSH_ACP_MAX_MS ?? 180_000);
const TAG = "dsh-acp-worker";
// pane の tail は古い行が流れるので、同じログをファイルにも積む(診断用)。
const LOG_FILE = process.env.DSH_ACP_LOG ?? join(tmpdir(), "dsh-acp-worker.log");
const log = (...parts) => {
  const line = `[${TAG} ${new Date().toISOString().slice(11, 19)} pid=${process.pid}] ${parts.join(" ")}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // ログファイルが書けなくても worker は止めない
  }
};
const warn = (...parts) => log(...parts);

// --- 1. dsh の Node エントリを解決(グローバル npm root、無ければ PATH 上のシムから導く)
const resolveDshBin = () => {
  const candidates = [];
  try {
    // Windows では npm は npm.cmd。spawnSync("npm") は EINVAL になるので明示する
    const npmShim = process.platform === "win32" ? "npm.cmd" : "npm";
    const root = spawnSync(npmShim, ["root", "-g"], { encoding: "utf8" }).stdout.trim();
    if (root) {
      candidates.push(join(root, "@deepseek-ai", "dsh", "lib", "bin.js"));
      candidates.push(join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
    }
  } catch {
    // npm が無い環境では PATH 経路だけを見る
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    candidates.push(join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

// --- 2. dsh-tui の Node エントリを解決(対話フォールバック用。シムは .cmd なので shell は使わない)
const resolveTuiBin = () => {
  if (TUI_BIN.length > 0) {
    return existsSync(TUI_BIN) ? TUI_BIN : null;
  }
  const candidates = [];
  try {
    const npmShim = process.platform === "win32" ? "npm.cmd" : "npm";
    const root = spawnSync(npmShim, ["root", "-g"], { encoding: "utf8" }).stdout.trim();
    if (root) {
      candidates.push(join(root, "@deepseek-harness-tui", "dsh-tui", "bin", "dsh-tui.js"));
      candidates.push(join(root, "node_modules", "@deepseek-harness-tui", "dsh-tui", "bin", "dsh-tui.js"));
    }
  } catch {
    // npm が無い環境では PATH 経路だけを見る
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    candidates.push(join(dir, "node_modules", "@deepseek-harness-tui", "dsh-tui", "bin", "dsh-tui.js"));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

// 対話フォールバックで起動した子がすでに終わっていることがある(panic 等)ので、
// 終了済みなら待たない。
const childDone = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : once(child, "exit").then(() => undefined).catch(() => undefined);

// --- 3. stdin を「注入された 1 塊」として拾う(PTY なので EOF を待たない)
// 注入は agent readiness の後に行われるため、起動直後の idle で切ると空で終わる(実測)。
// 1 塊を捕まえた以降は idle で締める。呼び出しごとにハンドラを付け外しして再利用する。
const readInjected = ({ firstMs, idleMs, maxMs, drainMs = 0 }) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    let buffer = "";
    let idleTimer = null;
    let hardTimer = null;
    let firstTimer = null;
    const elapsed = () => Date.now() - startedAt;
    const finish = (why) => {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      clearTimeout(firstTimer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
      log(`stdin 打ち切り(${why}) elapsed=${elapsed()}ms 長=${buffer.trim().length}字`);
      resolve(buffer.trim());
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish("idle"), idleMs);
    };
    const onData = (chunk) => {
      // 対話フォールバックの dsh-tui を殺した直後、マウス追跡等の CSI が stdin に漏れる(実測)。
      // drainMs の間のデータは捨てる(注入は readiness の後に来るので実害なし)。
      if (drainMs > 0 && elapsed() < drainMs) {
        log(`stdin drain 破棄 +${chunk.length}字 elapsed=${elapsed()}ms`);
        buffer = "";
        return;
      }
      buffer += chunk;
      log(`stdin chunk +${chunk.length}字 elapsed=${elapsed()}ms`);
      armIdle();
    };
    const onEnd = () => finish("end");
    hardTimer = setTimeout(() => finish("max"), maxMs);
    firstTimer = setTimeout(() => {
      if (buffer.length === 0) finish("first-chunk-timeout");
    }, firstMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  });

// --- 3. stdin が空だった場合の代替経路: 自分のタスクを Orca 側から逆引きする
// 注入は agent readiness の後にしか行われないため、報告を持たないエージェントは
// stdin を 1 バイトも受け取れない(実測 120s で 0 字)。自分の worktree のターミナルに
// 割り当てられた dispatch から task を辿る。
const normalizePath = (value) => String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const runOrca = (args) => {
  const stdout = execFileSync("orca", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (parsed?.ok !== true) {
    throw new Error(`orca ${args.join(" ")} => ${JSON.stringify(parsed?.error ?? parsed)}`);
  }
  return parsed.result ?? {};
};

const currentWorktreePath = () => {
  try {
    const path = runOrca(["worktree", "current", "--json"]).worktree?.path;
    return typeof path === "string" && path.length > 0 ? path : process.cwd();
  } catch (error) {
    warn(`worktree current 取得失敗(${error instanceof Error ? error.message : String(error)}) → cwd を使用`);
    return process.cwd();
  }
};

const resolveMyTask = async (deadlineMs = 90_000) => {
  const deadline = Date.now() + deadlineMs;
  // 1 回の試行が deadline を大きく超えると(実行中の run が多いとき)、対話フォールバックが
  // 止まる。内側のループでも deadline を見る。
  const outOfTime = () => Date.now() > deadline;
  while (!outOfTime()) {
    try {
      const myPath = normalizePath(runOrca(["worktree", "current", "--json"]).worktree?.path);
      const terminals = runOrca(["terminal", "list", "--json"]).terminals ?? [];
      const mine = terminals.find((row) => normalizePath(row.worktreePath) === myPath);
      if (mine?.handle) {
        // task-list は Run バインドが必要。このターミナルは未バインドなので run-list から辿る。
        // 新しい Run 4 本だけ(worker の dispatch は直近の Run にある)。広く回すと 1 周が
        // 20-30 秒になり、worker-start が完了した瞬間を素通りして取り逃す(実測デグレ)。
        const runs = (runOrca(["orchestration", "run-list", "--limit", "10", "--json"]).runs ?? [])
          .filter((row) => typeof row?.id === "string")
          .sort((a, b) => String(b?.created_at ?? "").localeCompare(String(a?.created_at ?? "")))
          .slice(0, 4);
        for (const runRow of runs) {
          if (outOfTime()) break;
          const runId = runRow.id;
          const tasks = runOrca(["orchestration", "task-list", "--run", runId, "--json"]).tasks ?? [];
          for (const row of tasks) {
            if (outOfTime()) break;
            if (typeof row.id !== "string") continue;
            const dispatch = runOrca(["orchestration", "dispatch-show", "--task", row.id, "--json"]).dispatch;
            if (dispatch?.assignee_handle !== mine.handle) continue;
            const spec = row.spec ?? row.task_title ?? row.display_name ?? null;
            if (typeof spec !== "string" || spec.length === 0) continue;
            log(`逆引き成功 task=${row.id} dispatch=${dispatch.id} run=${runId}`);
            return { taskId: row.id, dispatchId: dispatch.id, runId, spec };
          }
        }
      }
    } catch (error) {
      warn(`逆引き試行: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (outOfTime()) break;
    await new Promise((sleepResolve) => setTimeout(sleepResolve, 3_000));
  }
  return null;
};

// 報告の指針。dsh は agent hooks を持つので dispatch が ready まで行く可能性がある
// (hooks 導入前は agent_readiness で failed だった)。両方の経路を preamble に書く。
const buildPreamble = (found) => {
  const lines = [
    "You are a supervised Orca worker driven over ACP (no interactive approval prompts reach a human).",
    "Before you change any orchestration state, read the current CLI contract with:",
    "  orca skills get orchestration --full",
    "and never reuse memorized CLI syntax.",
  ];
  if (found) {
    lines.push(
      `Your task ID is: ${found.taskId}`,
      `Your dispatch ID is: ${found.dispatchId}`,
      `Your run ID is: ${found.runId}`,
      "Report when the work is done, exactly once, using your dispatch:",
      `  orca orchestration send --run ${found.runId} --type worker_done --outcome succeeded --task-id ${found.taskId} --dispatch-id ${found.dispatchId} --subject done --body "<3-sentence summary: what you did, what you found, what is left>"`,
      "If that send is refused because your dispatch is not live, fall back to the authoritative record:",
      `  orca orchestration task-update --id ${found.taskId} --status completed --result "<same summary>" --run ${found.runId}`,
      "Valid --status values are pending / ready / dispatched / completed / failed / blocked — there is no `success`.",
      "If a report is refused with consumer_fenced, re-bind YOUR OWN terminal once with",
      `  orca orchestration run-use --id ${found.runId}`,
      "and retry that report one time. Never touch another terminal's binding.",
      "If the work is not done, report status failed with the reason.",
      "Do not exit before reporting. Do not create new runs. Child tasks use --parent your own task id.",
      "worker-release / worker-list accounting belongs to the coordinator, not to you.",
    );
  } else {
    lines.push(
      "No task was reverse-looked-up for this terminal. Do the work, then report it with",
      "  orca orchestration send ... (see the orchestration skill) if you were given a task id.",
    );
  }
  lines.push("", "=== TASK ===", "");
  return lines.join("\n");
};

// --- 4. ACP クライアント(JSON-RPC over stdio、1 行 1 フレーム)
const connectAcp = (dshBin, cwd) => {
  const child = spawn(process.execPath, [dshBin, "--profile", PROFILE], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    windowsHide: true,
  });
  let seq = 0;
  const pending = new Map();
  // 子が生きていない間の書き込み(EPIPE)で落とさない。終了処理中の競合で実測した
  child.stdin.on("error", (error) => warn(`stdin 書き込み失敗 ${error.message}`));
  const write = (frame) => {
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      warn(`stdin 書き込み失敗 ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const send = (method, params) => {
    const id = ++seq;
    write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => pending.set(id, resolve));
  };

  // 承認プロンプトは ACP では JSON-RPC で届く。claude / codex のように人間を待たせない。
  const answerPermission = (msg) => {
    const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
    const wanted =
      PERMISSION === "reject"
        ? options.find((option) => option.kind === "reject_once") ??
          options.find((option) => option.kind === "reject_always")
        : options.find((option) => option.kind === PERMISSION) ??
          options.find((option) => option.kind === "allow_once") ??
          options.find((option) => option.kind === "allow_always");
    log(
      `permission ${JSON.stringify(msg.params?.toolCall?.title ?? msg.params).slice(0, 160)} → ${
        wanted ? `${wanted.kind}(${wanted.optionId})` : "cancelled"
      }`,
    );
    write({
      jsonrpc: "2.0",
      id: msg.id,
      // ACP の shape は { outcome: { outcome: "selected", optionId } } / { outcome: { outcome: "cancelled" } }
      // (SelectedPermissionOutcome)。{ selected: … } にすると拒否扱いで tool が failed になる(実測)
      result: {
        outcome: wanted ? { outcome: "selected", optionId: wanted.optionId } : { outcome: "cancelled" },
      },
    });
  };

  let lineBuffer = "";
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // stdout はプロトコル専用のはずだが、ユーザー plugin が混入し得る
      warn(`stdout に非 JSON: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
      return;
    }
    if (msg.method === "session/request_permission") {
      answerPermission(msg);
      return;
    }
    if (msg.method === "session/update") {
      renderUpdate(msg.params?.update ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      log(`notify ${msg.method} ${JSON.stringify(msg.params ?? {}).slice(0, 200)}`);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk;
    let index = lineBuffer.indexOf("\n");
    while (index >= 0) {
      const line = lineBuffer.slice(0, index);
      lineBuffer = lineBuffer.slice(index + 1);
      handleLine(line);
      index = lineBuffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text.length > 0) warn(`dsh stderr: ${text.slice(0, 400)}`);
  });

  return { child, send, write };
};

const renderUpdate = (update) => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      process.stdout.write(`[agent] ${update.content?.text ?? ""}\n`);
      break;
    case "agent_thought_chunk":
      log(`thought ${(update.content?.text ?? "").slice(0, 200)}`);
      break;
    case "tool_call":
      log(`tool ${update.title ?? update.kind ?? "?"} (${update.status ?? "?"})`);
      break;
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        log(`tool ${update.toolCallId} → ${update.status}`);
      }
      break;
    case "plan":
      log(`plan ${JSON.stringify(update.entries ?? []).slice(0, 300)}`);
      break;
    case "usage_update":
      log(`usage ${update.used}/${update.size}`);
      break;
    case "config_option_update":
      log(`config ${(update.configOptions ?? []).map((option) => `${option.id}=${option.currentValue}`).join(" ")}`);
      break;
    default:
      log(`update ${update.sessionUpdate}`);
  }
};

// --- 5. 本体
const dshBin = resolveDshBin();
if (dshBin === null) {
  console.error(`${TAG}: dsh の bin.js が見つかりません(npm root -g 配下 "@deepseek-ai/dsh/lib/bin.js")`);
  process.exit(3);
}

const cwd = currentWorktreePath();
log(`dsh bin = ${dshBin}`);
log(`worktree cwd = ${cwd}`);

// 判定: 注入が来なければ dsh-tui を**先に起動**しつつ、並行して dispatch を照合する。
//   対話 pane  → 照合は空のまま → そのまま TUI で作業できる(起動を待たせない)
//   worker pane → 照合が当たる(worker の dispatch が見えるのは readiness 失敗後 ~110 秒、
//                  worker-start が完了する ~170 秒の窓がある)→ TUI を止めて worker モードへ
// launch token は対話 pane にも入る(実測)ので判定には使わない(診断表示のみ)。
const workerMarked = LAUNCH_TOKEN !== "";
log(`launch token = ${workerMarked ? "あり" : "なし"}`);

const tuiBin = NO_FALLBACK ? null : resolveTuiBin();
let firstText = await readInjected({ firstMs: QUICK_FIRST_MS, idleMs: IDLE_MS, maxMs: MAX_MS });
let found = null;
let interactiveChild = null;

if (firstText.length === 0) {
  if (tuiBin !== null) {
    log(`対話フォールバックを先読みで起動します ${tuiBin}`);
    interactiveChild = spawn(process.execPath, [tuiBin, ...TUI_ARGS], {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    interactiveChild.on("error", (error) => {
      warn(`dsh-tui 起動失敗 ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  found = await resolveMyTask(LOOKUP_MS);
  log(found ? `照合結果: task=${found.taskId} dispatch=${found.dispatchId}` : `照合上限 ${LOOKUP_MS}ms で dispatch なし`);
  if (found === null) {
    if (interactiveChild === null) {
      console.error(`${TAG}: タスクを取得できませんでした(注入も dispatch 照合も空)`);
      process.exit(2);
    }
    // 対話 pane: TUI が終わるまでここで待つ
    await childDone(interactiveChild);
    process.exit(0);
  }
  if (interactiveChild !== null) {
    log("worker と判明 — 対話プロセスを止めて worker モードへ");
    interactiveChild.kill();
    await childDone(interactiveChild);
    // dsh-tui が仕込んだマウス追跡/代替画面を元に戻す(殺した後の漏れ対策)
    process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1049l\x1b[2J\x1b[H");
  }
  process.stdin.resume();
  firstText = await readInjected({
    firstMs: FIRST_CHUNK_MS,
    idleMs: IDLE_MS,
    maxMs: MAX_MS,
    drainMs: interactiveChild !== null ? 1_000 : 0,
  });
}
if (firstText.length === 0) {
  firstText = found ? buildPreamble(found) + found.spec : "";
} else if (found !== null) {
  // 注入されたテキストにも報告の指針を添える(dispatch / task が逆引きできた場合だけ)
  firstText = `${buildPreamble(found)}${firstText}`;
}
if (firstText.length === 0) {
  console.error(`${TAG}: タスクを取得できませんでした(注入も dispatch 照合も空)`);
  process.exit(2);
}

let mcpServers = [];
if (process.env.DSH_ACP_MCP) {
  try {
    const parsed = JSON.parse(process.env.DSH_ACP_MCP);
    if (Array.isArray(parsed)) mcpServers = parsed;
    else warn("DSH_ACP_MCP は配列で指定してください(無視しました)");
  } catch (error) {
    warn(`DSH_ACP_MCP が JSON として読めません(${error instanceof Error ? error.message : String(error)})`);
  }
}

const acp = connectAcp(dshBin, cwd);

let exiting = false;
let sessionId = null;
const shutdown = async (why, code = 0) => {
  if (exiting) return;
  exiting = true;
  log(`終了開始(${why})`);
  if (sessionId !== null) {
    await Promise.race([
      acp.send("session/close", { sessionId }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  acp.child.stdin.end();
  acp.child.kill("SIGTERM");
  process.exit(code);
};
process.on("SIGINT", () => void shutdown("SIGINT", 130));
process.on("SIGTERM", () => void shutdown("SIGTERM", 143));
acp.child.on("exit", (code, signal) => {
  if (exiting) return;
  console.error(`${TAG}: dsh プロセスが終了 code=${code} signal=${signal ?? "none"}`);
  process.exit(code ?? 1);
});

const init = await acp.send("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
if (init.error) {
  console.error(`${TAG}: initialize 失敗 ${JSON.stringify(init.error)}`);
  process.exit(4);
}
log(`agent = ${JSON.stringify(init.result?.agentInfo ?? {})} capabilities = ${JSON.stringify(init.result?.agentCapabilities ?? {})}`);

const created = await acp.send("session/new", { cwd, mcpServers });
if (created.error) {
  console.error(`${TAG}: session/new 失敗 ${JSON.stringify(created.error)}`);
  process.exit(5);
}
sessionId = created.result?.sessionId ?? null;
log(`session = ${sessionId}`);

// モデルと effort は worker-start では渡せない(worker-start の --model/--effort は
// Claude / Codex / Cursor / Antigravity / Muse 限定)。ACP 側で焼く。
const configOptions = created.result?.configOptions ?? [];
if (process.env.DSH_ACP_MODEL) {
  const modelOption = configOptions.find((option) => option.id === "model");
  const [provider, ...rest] = String(process.env.DSH_ACP_MODEL).split("/");
  const model = rest.join("/");
  const encoded = JSON.stringify([provider, model]);
  const known = (modelOption?.options ?? []).some((group) =>
    (group.options ?? []).some((entry) => entry.value === encoded),
  );
  if (!known) {
    warn(`DSH_ACP_MODEL=${process.env.DSH_ACP_MODEL} は広告されたモデルにありません(設定をスキップします)`);
  } else {
    const set = await acp.send("session/set_config_option", { sessionId, configId: "model", value: encoded });
    log(`model 設定 ${set.error ? JSON.stringify(set.error) : process.env.DSH_ACP_MODEL}`);
  }
}
if (process.env.DSH_ACP_EFFORT) {
  const set = await acp.send("session/set_config_option", {
    sessionId,
    configId: "reasoning_effort",
    value: process.env.DSH_ACP_EFFORT,
  });
  log(`effort 設定 ${set.error ? JSON.stringify(set.error) : process.env.DSH_ACP_EFFORT}`);
}

let turns = 0;
let text = firstText;
while (!exiting && turns < MAX_TURNS) {
  turns += 1;
  const t0 = Date.now();
  const result = await acp.send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
  });
  const stopReason = result.result?.stopReason;
  log(`turn ${turns} 完了 ${JSON.stringify(stopReason ?? result.error)} (${Date.now() - t0}ms)`);
  if (result.error) {
    warn(`prompt 失敗 ${JSON.stringify(result.error)}`);
  }

  // ターン後は次の注入を待つ。来なければ終了(Commander は同じセッションで複数ターンできる)
  const next = await readInjected({ firstMs: IDLE_EXIT_MS, idleMs: IDLE_MS, maxMs: IDLE_EXIT_MS });
  if (next.length === 0) {
    await shutdown("次の注入なし");
    break;
  }
  text = next;
}

await shutdown(`ターン上限 ${MAX_TURNS}`);
