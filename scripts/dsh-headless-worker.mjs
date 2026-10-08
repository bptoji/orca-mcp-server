// dsh headless を Orca supervised worker にするブリッジ。
//
// 背景: worker-start の注入はターミナル(PTY)への入力として届く。
//   dsh --profile headless            → タスクが argv に無く即 exit("a task is required")
//   dsh --profile headless -          → stdin の EOF を待つ。PTY は EOF を送らないので永久に待つ
// そこで「注入テキストを stdin から拾って argv に載せ直す」のがこのラッパー。
//
// 使い方(Orca のエージェント起動コマンドとして設定する):
//   node C:\...\orca-mcp\scripts\dsh-headless-worker.mjs
//
// 挙動:
//   1. stdin を読む。4 秒間データが無いか、最大 30 秒で打ち切ってタスク確定
//   2. node <dsh の bin.js> --profile headless <task> を argv 配列で起動(shell 文字列は作らない)
//   3. dsh の stdout/stderr をそのままターミナルへ流し、終了コードを返す
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";

const FIRST_CHUNK_MS = 20_000;
const IDLE_MS = 4_000;
const MAX_MS = 180_000;

// --- 1. stdin を「注入された 1 塊」として拾う(PTY なので EOF を待たない)
// 最初の 1 塊が来るまで長く待つ。注入は agent readiness の後に行われるため、
// 起動直後の 4 秒 idle で切ると空で終わる(実測)。1 塊を捕まえた以降は idle で締める。
const readInjectedTask = () =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    let buffer = "";
    let idleTimer = null;
    const elapsed = () => Date.now() - startedAt;
    const finish = (why) => {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      clearTimeout(firstTimer);
      process.stdin.pause();
      console.log(`[dsh-headless-worker] stdin 打ち切り(${why}) elapsed=${elapsed()}ms 長=${buffer.trim().length}字`);
      resolve(buffer.trim());
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish("idle"), IDLE_MS);
    };
    const hardTimer = setTimeout(() => finish("max"), MAX_MS);
    const firstTimer = setTimeout(() => {
      if (buffer.length === 0) {
        finish("first-chunk-timeout");
      }
    }, FIRST_CHUNK_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      console.log(`[dsh-headless-worker] stdin chunk +${chunk.length}字 elapsed=${elapsed()}ms`);
      armIdle();
    });
    process.stdin.on("end", () => finish("end"));
  });

// --- 2. dsh の Node エントリを解決(グローバル npm root、無ければ PATH 上の dsh シムから導く)
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
  // dsh.ps1 / dsh.cmd の隣に node_modules/@deepseek-ai/dsh がある(npm のシム配置)
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    candidates.push(join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

// --- 2b. stdin が空だった場合の代替経路: 自分のタスクを Orca 側から拾う。
// 注入は agent readiness(agent hooks を持つ claude / codex など)の後にしか行われないため、
// dsh のような無報告エージェントは stdin を 1 バイトも受け取れない(実測 120s で 0 字)。
// そこで「この worktree のターミナルに割り当てられた dispatch の task」を逆引きする。
const normalizePath = (value) => String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const runOrca = (args) => {
  const stdout = execFileSync("orca", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (parsed?.ok !== true) {
    throw new Error(`orca ${args.join(" ")} => ${JSON.stringify(parsed?.error ?? parsed)}`);
  }
  return parsed.result ?? {};
};

const resolveMyTask = async () => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const worktree = runOrca(["worktree", "current", "--json"]).worktree;
      const myPath = normalizePath(worktree?.path);
      const terminals = runOrca(["terminal", "list", "--json"]).terminals ?? [];
      const mine = terminals.find((row) => normalizePath(row.worktreePath) === myPath);
      if (mine?.handle) {
        // task-list は Run バインドが必要。このターミナルは未バインドなので run-list から辿る
        const runs = runOrca(["orchestration", "run-list", "--limit", "20", "--json"]).runs ?? [];
        for (const runRow of runs) {
          const runId = typeof runRow?.id === "string" ? runRow.id : null;
          if (!runId) continue;
          const tasks = runOrca(["orchestration", "task-list", "--run", runId, "--json"]).tasks ?? [];
          for (const row of tasks) {
            if (typeof row.id !== "string") continue;
            const dispatch = runOrca(["orchestration", "dispatch-show", "--task", row.id, "--json"]).dispatch;
            if (dispatch?.assignee_handle === mine.handle) {
              const spec = row.spec ?? row.task_title ?? row.display_name ?? null;
              if (typeof spec === "string" && spec.length > 0) {
                // dsh は Orca の readiness フックを持たないため dispatch は agent_readiness で
                // failed になる。worker_done は failed dispatch を完走させられないので、
                // 報告は task-update を正とする(ゲートウェイの poll は task 状態を読む)。
                const preamble = [
                  "You are a supervised Orca worker running headless (no interactive approval).",
                  `Your task ID is: ${row.id}`,
                  `Your dispatch ID is: ${dispatch.id}`,
                  `Your run ID is: ${runId}`,
                  "Your dispatch is already marked failed because this agent has no Orca readiness hooks.",
                  "That is expected: report your result with task-update, which is the authoritative record.",
                  "When the work is done, run exactly once:",
                  `orca orchestration task-update --id ${row.id} --status success --result "<3-sentence summary: what you did, what you found, what is left>" --run ${runId}`,
                  "If the work is not done, use --status failed with the reason in --result.",
                  "Do not exit before reporting. Do not create new runs or tasks.",
                  "",
                  "=== TASK ===",
                  spec,
                ].join("\n");
                console.log(`[dsh-headless-worker] 逆引き成功 task=${row.id} dispatch=${dispatch.id} run=${runId}`);
                return preamble;
              }
            }
          }
        }
      }
    } catch (error) {
      console.log(`[dsh-headless-worker] 逆引き試行: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((sleepResolve) => setTimeout(sleepResolve, 5_000));
  }
  return null;
};

let task = await readInjectedTask();
if (task.length === 0) {
  console.log("[dsh-headless-worker] stdin が空なので Orca 側から逆引きします");
  task = (await resolveMyTask()) ?? "";
}
if (task.length === 0) {
  console.error("dsh-headless-worker: タスクを取得できませんでした(stdin 注入も逆引きも空)");
  process.exit(2);
}

const dshBin = resolveDshBin();
if (dshBin === null) {
  console.error('dsh-headless-worker: dsh の bin.js が見つかりません(npm root -g 配下 "@deepseek-ai/dsh/lib/bin.js")');
  process.exit(3);
}

console.log(`[dsh-headless-worker] task ${task.length} 字を受け取り、headless を起動します`);

// --- 3. argv 配列で起動(shell に渡さない = 注入テキストをエスケープしない)
const child = spawn(process.execPath, [dshBin, "--profile", "headless", task], {
  stdio: "inherit",
  windowsHide: true,
});

child.on("close", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error(`dsh-headless-worker: 起動に失敗 ${error instanceof Error ? error.message : String(error)}`);
  process.exit(4);
});
