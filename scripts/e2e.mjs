// E2E: readiness → delegate → poll → gate → result → cancel(実 Orca / 実エージェント)
//
// 使い方:
//   node scripts/e2e.mjs [--repo name:weever] [--goal "<goal>"] [--minutes 30] [--cleanup]
//
// 前提:
//   - npm run build 済み(dist/index.js がある)
//   - Orca ランタイムが起動していること(未起動なら orca open)
//   - commanderAgent の既定は claude(このホストの orchestration skill は providers: agent-skills, claude)
//
// やっていること(レビュー指摘の E2E と同じ手順):
//   1. orca_readiness          … 前提確認(準備でなければここで中止)
//   2. orca_delegate_task      … Commander 起動(submit)。この worktree から child worktree を作るので
//                                 本体の作業ツリーは触らない
//   3. orca_get_task_status    … 30 秒間隔の poll(他作業を挟む想定の挙動)。children / gates を記録
//   4. orca_resolve_gate       … pending gate を "approve (e2e)" で解決(Human-in-the-loop の代替)
//   5. orca_get_task_result    … includeChildren: true で子タスクの成果まで集約
//   6. orca_cancel_task        … 2 本目を途中で cascade cancel → fullyStopped と子孫停止を確認
//   7. 後片付け               … 作られた child worktree を表示(--cleanup なら orca worktree rm)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const options = {
  server: resolve("dist/index.js"),
  // repo は **repo セレクタ**で解決される(worktree の displayName や worktree path は repo_not_found になる)。
  // 実機確認: id:<repoId> と path:<repo home> は ok / path:<worktree path> は repo_not_found。
  // → 既定は `orca worktree current` から拾った repoId(この worktree の repo)。
  repo: readFlag("repo", ""),
  repoIdFallback: true,
  commanderAgent: readFlag("agent", "claude"),
  minutes: Number(readFlag("minutes", "30")),
  cleanup: hasFlag("cleanup"),
  goal: readFlag(
    "goal",
    "README.md の末尾に「E2E 検証記録」セクションを 1 つ追記する(実施日と、実行した MCP ツール名を 3〜5 行の箇条書き)。" +
      "追記後に npm test を実行して結果を報告する。変更は README.md のみに限定する。",
  ),
  cancelGoal: readFlag(
    "cancel-goal",
    "新規ファイル e2e-cancel-note.md を作り、その中に E2E-CANCEL という 1 行だけ書く。",
  ),
};

const transcript = {
  startedAt: new Date().toISOString(),
  options: { repo: options.repo, commanderAgent: options.commanderAgent, minutes: options.minutes },
  steps: [],
};
const log = (line) => {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${line}`);
};
const record = (step, payload) => {
  transcript.steps.push({ at: new Date().toISOString(), step, payload });
};

// ---------------------------------------------------------------- MCP クライアント(stdio)
const child = spawn(process.execPath, [options.server], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log(`(non-JSON line skipped) ${line.slice(0, 120)}`);
      }
      if (message !== undefined) {
        const resolver = pending.get(message.id);
        if (resolver !== undefined) {
          pending.delete(message.id);
          resolver(message);
        }
      }
    }
    index = buffer.indexOf("\n");
  }
});

const rpc = (method, params) => {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolvePromise) => pending.set(id, resolvePromise));
};

const call = async (name, args) => {
  const response = await rpc("tools/call", { name, arguments: args });
  const text = response.result?.content?.[0]?.text ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { isError: response.result?.isError === true, parsed };
};

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// ---------------------------------------------------------------- 1. readiness
const main = async () => {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orca-mcp-e2e", version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  // repo セレクタ未指定なら、この worktree の repoId を拾う(id:<repoId> は実機で解決確認済み)
  if (options.repo === "") {
    const current = await runCli(["worktree", "current", "--json"]);
    const repoId = current.parsed?.result?.worktree?.repoId;
    if (typeof repoId !== "string") {
      log("repo を特定できませんでした(worktree current 失敗)。--repo id:<repoId> を指定してください");
      finish(5);
      return;
    }
    options.repo = `id:${repoId}`;
  }
  log(`repo selector = ${options.repo}`);
  record("repo_selector", { repo: options.repo });

  const readiness = await call("orca_readiness", { commanderAgent: options.commanderAgent });
  log(`readiness ready=${readiness.parsed?.ready} missing=${JSON.stringify(readiness.parsed?.missing)}`);
  record("readiness", readiness.parsed);
  if (readiness.isError || readiness.parsed?.ready !== true) {
    log(`準備が足りないため中止: ${readiness.parsed?.nextAction ?? "readiness 失敗"}`);
    finish(2);
    return;
  }

  // ---------------------------------------------------------------- 2. delegate(submit)
  const delegated = await call("orca_delegate_task", {
    spec: options.goal,
    title: "E2E README 検証記録",
    commanderAgent: options.commanderAgent,
    repo: options.repo,
    constraints: ["マージ・push・deploy をしない", "既存のテストを壊さない", "変更は README.md のみに限定する"],
  });
  const taskId = delegated.parsed?.taskId;
  const runId = delegated.parsed?.runId;
  log(`delegate isError=${delegated.isError} taskId=${taskId} state=${delegated.parsed?.state} runId=${runId}`);
  log(`delegate warnings=${JSON.stringify(delegated.parsed?.warnings ?? [])}`);
  record("delegate", delegated.parsed);
  if (delegated.isError || typeof taskId !== "string") {
    log("delegate に失敗したため中止");
    finish(3);
    return;
  }
  if (delegated.parsed?.state === "queued") {
    // worker-start が失敗すると queued で止まる(放置しても進まない)→ ここで止めて原因を出す
    log(`Commander が起動していない(state=queued)。warnings を確認してください: ${JSON.stringify(delegated.parsed?.warnings)}`);
    const cancelled = await call("orca_cancel_task", { taskId, run: runId, reason: "E2E: worker-start 失敗" });
    log(`queued を cancel(isError=${cancelled.isError} cancelled=${cancelled.parsed?.cancelled})`);
    record("cancel_queued", cancelled.parsed);
    finish(4);
    return;
  }

  // ---------------------------------------------------------------- 3-4. poll / gate
  const gatesResolved = [];
  const deadline = Date.now() + options.minutes * 60_000;
  let last = null;
  let polls = 0;

  while (Date.now() < deadline) {
    polls += 1;
    const status = await call("orca_get_task_status", { taskId, run: runId });
    last = status.parsed;
    log(
      `poll#${polls} state=${last?.state} phase=${last?.phase} children=${last?.childCount ?? 0}` +
        ` gates=${(last?.gates ?? []).length}` +
        ` subRuns=${last?.subRunsDiscovered ?? 0}` +
        ` scanComplete=${last?.subRunScanComplete}(pages=${last?.subRunScanPageCount}, runs=${last?.subRunScanRunCount})` +
        ` ownershipComplete=${last?.subRunOwnershipComplete}`,
    );
    if (polls === 1 || polls % 5 === 0) {
      record(`poll#${polls}`, {
        state: last?.state,
        phase: last?.phase,
        childCount: last?.childCount,
        children: last?.children,
        gates: last?.gates,
        workers: last?.workers,
        subRunsDiscovered: last?.subRunsDiscovered,
        subRuns: last?.subRuns,
        subRunScanComplete: last?.subRunScanComplete,
        subRunsTruncated: last?.subRunsTruncated,
        subRunScanPageCount: last?.subRunScanPageCount,
        subRunScanRunCount: last?.subRunScanRunCount,
        subRunOwnershipComplete: last?.subRunOwnershipComplete,
        blockedReasons: last?.blockedReasons,
        warnings: last?.warnings,
      });
    }

    const pendingGates = (last?.gates ?? []).filter((gate) => gate.status === "pending");
    for (const gate of pendingGates) {
      // gate-resolve には --run が無いので「ゲートの所属 Run」を叩く(sub-run のゲートは呼び出し元 Run と違う)
      const gateRun = typeof gate.runId === "string" && gate.runId.length > 0 ? gate.runId : runId;
      const resolved = await call("orca_resolve_gate", {
        gateId: gate.id,
        resolution: "approve (e2e)",
        run: gateRun,
      });
      log(`gate ${gate.id} → approve (e2e) run=${gateRun} isError=${resolved.isError}`);
      gatesResolved.push({
        gateId: gate.id,
        gateRun,
        callerRun: runId,
        question: gate.question ?? null,
        result: resolved.parsed,
      });
      record("resolve_gate", { gateId: gate.id, gateRun, callerRun: runId, result: resolved.parsed });
    }

    if (["completed", "failed", "cancelled"].includes(last?.state)) {
      break;
    }
    await sleep(30_000);
  }

  log(`poll 終了(state=${last?.state} polls=${polls} gates=${gatesResolved.length})`);

  // ---------------------------------------------------------------- 5. result
  const result = await call("orca_get_task_result", { taskId, run: runId, includeChildren: true });
  log(`result isError=${result.isError} state=${result.parsed?.state} children=${(result.parsed?.children ?? []).length}`);
  record("result", {
    state: result.parsed?.state,
    resultPreview: result.parsed?.resultPreview,
    subRunsDiscovered: result.parsed?.subRunsDiscovered,
    subRuns: result.parsed?.subRuns,
    warnings: result.parsed?.warnings,
    children: (result.parsed?.children ?? []).map((child) => ({
      taskId: child.taskId,
      title: child.title,
      state: child.state,
      sourceRunId: child.sourceRunId,
      resultPreview: child.resultPreview,
      outputs: (child.outputs ?? []).map((output) => ({ dispatchId: output.dispatchId, agent: output.agent })),
    })),
  });

  // ---------------------------------------------------------------- 6. cancel(2 本目を途中で)
  const cancelJob = await call("orca_delegate_task", {
    spec: options.cancelGoal,
    title: "E2E cancel 検証",
    commanderAgent: options.commanderAgent,
    repo: options.repo,
    constraints: ["マージ・push をしない"],
  });
  const cancelTaskId = cancelJob.parsed?.taskId;
  const cancelRunId = cancelJob.parsed?.runId;
  log(`cancel job delegate taskId=${cancelTaskId} state=${cancelJob.parsed?.state}`);
  record("cancel_delegate", cancelJob.parsed);

  let cancelView = null;
  let cancelledSummary = {};
  if (typeof cancelTaskId === "string") {
    for (let index = 0; index < 6; index += 1) {
      const status = await call("orca_get_task_status", { taskId: cancelTaskId, run: cancelRunId });
      cancelView = status.parsed;
      log(
        `cancel poll#${index + 1} state=${cancelView?.state} children=${cancelView?.childCount ?? 0}` +
          ` workers=${(cancelView?.workers ?? []).length}` +
          ` subRuns=${cancelView?.subRunsDiscovered ?? 0}`,
      );
      if ((cancelView?.childCount ?? 0) > 0 || (cancelView?.workers ?? []).length > 0) {
        break;
      }
      await sleep(20_000);
    }

    const cancelled = await call("orca_cancel_task", { taskId: cancelTaskId, run: cancelRunId, reason: "E2E cancel 検証" });
    log(
      `cancel isError=${cancelled.isError} cancelled=${cancelled.parsed?.cancelled}` +
        ` fullyStopped=${cancelled.parsed?.fullyStopped} taskCount=${cancelled.parsed?.taskCount}` +
        ` subRunsDiscovered=${cancelled.parsed?.subRunsDiscovered ?? 0}` +
        ` residual=${(cancelled.parsed?.residualWorkers ?? []).length}` +
        ` scanComplete=${cancelled.parsed?.subRunScanComplete}`,
    );
    record("cancel", cancelled.parsed);
    cancelledSummary = cancelled.parsed ?? {};
    if (cancelled.isError && cancelled.parsed?.code === "cancel_ownership_unverified") {
      log(`cancel_ownership_unverified: ${JSON.stringify(cancelled.parsed?.detail?.subRuns ?? [])}`);
    }

    const after = await call("orca_get_task_status", { taskId: cancelTaskId, run: cancelRunId });
    log(`cancel 後 state=${after.parsed?.state} children=${after.parsed?.childCount ?? 0}`);
    record("cancel_after", {
      state: after.parsed?.state,
      children: (after.parsed?.children ?? []).map((child) => ({ taskId: child.taskId, state: child.state })),
    });
  }

  // ---------------------------------------------------------------- 7. 後片付け
  const worktrees = await call("orca_list_worktrees", {});
  // orca_list_worktrees は CLI のエンベロープをそのまま返す(result.worktrees)
  const rows = worktrees.parsed?.result?.worktrees ?? worktrees.parsed?.worktrees ?? [];
  const created = rows.filter((worktree) => /e2e/i.test(String(worktree.displayName ?? "")));
  record("worktrees", created);
  log(`child worktree 候補: ${created.map((worktree) => worktree.displayName).join(", ") || "なし"}`);

  if (options.cleanup && created.length > 0) {
    for (const worktree of created) {
      const removed = await runCli(["worktree", "rm", "--worktree", `name:${worktree.displayName}`, "--force", "--json"]);
      log(`worktree rm ${worktree.displayName} ok=${removed.ok}`);
      record("worktree_rm", { displayName: worktree.displayName, ok: removed.ok });
    }
  }

  transcript.finishedAt = new Date().toISOString();
  transcript.summary = {
    taskId,
    runId,
    finalState: last?.state,
    polls,
    gatesResolved: gatesResolved.length,
    gateRuns: gatesResolved.map((gate) => `${gate.gateId}@${gate.gateRun}`),
    subRunsDiscovered: last?.subRunsDiscovered ?? 0,
    subRunOwnership: (last?.subRuns ?? []).map((row) => `${row.runId}:${row.ownership}`),
    subRunScanComplete: last?.subRunScanComplete ?? null,
    subRunScanPageCount: last?.subRunScanPageCount ?? null,
    subRunScanRunCount: last?.subRunScanRunCount ?? null,
    resultChildren: (result.parsed?.children ?? []).length,
    cancelTaskId,
    cancelState: cancelView?.state ?? null,
    cancelFullyStopped: cancelledSummary.fullyStopped ?? null,
    cancelResidualWorkers: cancelledSummary.residualWorkers?.length ?? 0,
    cancelErrorCode: cancelledSummary.code ?? null,
  };
  writeFileSync("e2e-transcript.json", JSON.stringify(transcript, null, 2), "utf8");
  log("トランスクリプトを e2e-transcript.json に保存しました");
  console.log(JSON.stringify(transcript.summary, null, 2));
  finish(0);
};

// orca CLI を 1 回叩く(後片付け用。argv 配列のみ / shell 文字列を作らない)
const runCli = (args) =>
  new Promise((resolvePromise) => {
    const proc = spawn("orca", args, { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    let stdout = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.on("close", (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      resolvePromise({ ok: code === 0 && parsed?.ok === true, parsed });
    });
  });

const finish = async (code) => {
  transcript.finishedAt = new Date().toISOString();
  try {
    writeFileSync("e2e-transcript.json", JSON.stringify(transcript, null, 2), "utf8");
  } catch {
    // 書き出し失敗は終了コードで伝える
  }
  child.stdin.end();
  child.kill();
  process.exit(code);
};

main().catch(async (error) => {
  log(`想定外のエラー: ${error instanceof Error ? error.message : String(error)}`);
  record("fatal", { message: error instanceof Error ? error.message : String(error) });
  await finish(1);
});
