// sub-run 観測の実機検証(read-only)。変更系コマンドは一切叩かない。
//
// 使い方:
//   npm run build
//   node scripts/observe-subrun.mjs --task task_7ec3d98f5473 --run run_6a42e93d341d
//
// 目的:
//   P0–P5 で追加した応答フィールドが**実データで出ているか**を機械的に確認する。
//   既存の pending gate を解決したり、worker を止めたりはしない(読むだけ)。
//
// 終了コード:
//   0 = 期待するフィールドが揃っている
//   1 = 検証失敗(フィールド欠落)
//   2 = 使い方が不正 / orca が読めない
import { getTaskStatus } from "../dist/orca/job.js";
import { OrcaClient } from "../dist/orca/client.js";

const argv = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const taskId = readFlag("task", null);
const runId = readFlag("run", null);
if (taskId === null || runId === null) {
  console.error("使い方: node scripts/observe-subrun.mjs --task <taskId> --run <runId>");
  process.exit(2);
}

const client = new OrcaClient();
const view = await getTaskStatus(client, { taskId, run: runId });

const subRuns = Array.isArray(view["subRuns"]) ? view["subRuns"] : [];
const gates = Array.isArray(view["gates"]) ? view["gates"] : [];
const children = Array.isArray(view["children"]) ? view["children"] : [];
const reasons = Array.isArray(view["blockedReasons"]) ? view["blockedReasons"] : [];

const report = {
  taskId: view["taskId"],
  state: view["state"],
  phase: view["phase"],
  runId: view["runId"],
  childCount: view["childCount"],
  subRunsDiscovered: view["subRunsDiscovered"],
  subRunScanComplete: view["subRunScanComplete"],
  subRunsTruncated: view["subRunsTruncated"],
  subRunScanPageCount: view["subRunScanPageCount"],
  subRunScanRunCount: view["subRunScanRunCount"],
  subRunOwnershipComplete: view["subRunOwnershipComplete"],
  subRuns: subRuns.map((row) => ({
    runId: row["runId"],
    ownership: row["ownership"],
    cancelEligible: row["cancelEligible"],
    discoverySource: row["discoverySource"],
    verificationReasons: row["verificationReasons"],
    taskCount: row["taskCount"],
    rootTaskIds: row["rootTaskIds"],
  })),
  children: children.map((row) => ({
    taskId: row["taskId"],
    state: row["state"],
    sourceRunId: row["sourceRunId"],
  })),
  gates: gates.map((row) => ({
    id: row["id"],
    runId: row["runId"],
    taskId: row["taskId"],
    status: row["status"],
  })),
  gateReasons: reasons
    .filter((row) => row["kind"] === "gate")
    .map((row) => ({ taskId: row["taskId"], role: row["role"], detail: row["detail"] })),
  warnings: view["warnings"],
};

console.log(JSON.stringify(report, null, 2));

const failures = [];
if (gates.length > 0 && gates.some((gate) => typeof gate["runId"] !== "string")) {
  failures.push("gates[].runId が無いゲート行がある(orca_resolve_gate の run が決められない)");
}
if (subRuns.length > 0) {
  if (subRuns.some((row) => typeof row["ownership"] !== "string")) {
    failures.push("subRuns[].ownership が無い行がある");
  }
  if (subRuns.some((row) => typeof row["cancelEligible"] !== "boolean")) {
    failures.push("subRuns[].cancelEligible が無い行がある");
  }
  if (children.some((row) => typeof row["sourceRunId"] !== "string")) {
    failures.push("sub-run 由来の children 行に sourceRunId が無い");
  }
}
if (typeof view["subRunScanComplete"] !== "boolean") {
  failures.push("subRunScanComplete が無い(スキャンの完全性を正直に出していない)");
}
if (reasons.length > 0 && gates.length > 0) {
  const gateReason = reasons.find((row) => row["kind"] === "gate");
  const detail = gateReason?.["detail"];
  if (!detail || typeof detail["runId"] !== "string") {
    failures.push("gate 由来の blockedReasons.detail.runId が無い");
  }
}

if (failures.length > 0) {
  console.error("検証失敗:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log("検証成功: gates[].runId / subRuns[].ownership / sourceRunId / scan フィールドが揃っています(読み取りのみ)");
