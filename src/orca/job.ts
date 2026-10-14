import { createHash } from "node:crypto";
import { OrcaCommandError } from "./command.js";
import {
  extractTasks,
  type JsonObject,
  type OrcaClient,
} from "./client.js";

/**
 * 非同期 Job API の内部モデル。
 *
 * 原則: MCP の 1 呼び出しを長時間ブロックしない。
 *  - submit(orca_delegate_task) … run-create + task-create + worker-start までを素早く済ませ、
 *    `{ taskId, state: "running", commander: true }` を返して即座に応答する。
 *  - poll(orca_get_task_status) … 現在の state / phase / workers / children を返す。
 *  - result(orca_get_task_result) … 完了時の result と worker 出力のし尾部を返す。
 *  - intervene(send / cancelTask / resolveGate) … 頼まれたときだけ変更する。
 */

export type JobState =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type JobPhase =
  | "queued"
  | "starting"
  | "implementation"
  | "decision_gate"
  | "blocked"
  | "settling"
  | "finished"
  | "failed"
  | "unknown";

/** ジョブ層の失敗(CLI 側の失敗ではない)。code を応答に載せる。 */
export class JobError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "JobError";
    this.code = code;
    this.detail = detail;
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** orca の `{ ok, result }` エンベロープから result 本体を取り出す(無ければそのまま)。 */
export function unwrapResult(payload: JsonObject): JsonObject {
  return isJsonObject(payload["result"]) ? (payload["result"] as JsonObject) : payload;
}

/**
 * 変更系操作を 1 本に直列化する相互排他。
 *
 * orca CLI の「現在バインド中の Run」は**この MCP プロセス共有の状態**である。
 * 並行リクエストが `run-use` を交互に叩くと、A が切り替えたバインドを B が書き換えて
 * A の再試行が別 Run に届く(または consumer_fenced のループ)ため、
 * `run-use` + mutation の並びを丸ごと直列化する。
 * 読み取り(task-list / worker-list など)はロックしない。
 */
class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => task());
    // 失敗を後続に伝播させない(1 件の失敗でキューを壊さない)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const runBindingQueue = new MutationQueue();

/**
 * Run バインドに紐づく変更系コマンドを実行する(直列化された 1 本の中で)。
 *
 * orca CLI は呼び出し元(この MCP サーバーを起動したターミナル)を 1 つの Run に
 * バインドする。別の Run に対して `task-update` 等を行うと `consumer_fenced` で
 * 拒否されるため、そのときだけ `run-use` でバインドを切り替えて 1 回再試行する。
 *
 * バインドが**空**のターミナルから叩くと `run_required`("No Run is bound. Use
 * orchestration run-create or run-use first.") になる(実測: gate-resolve が 0 件でなく
 * 失敗した)。CLI の推奨どおり `run-use` でバインドして 1 回だけ再試行する —
 * どちらも「渡す Run が決まっているなら復旧できる」同じ型の失敗なのでまとめて扱う。
 */
export async function runMutation<T>(
  client: OrcaClient,
  runId: string | undefined,
  mutate: () => Promise<T>,
): Promise<T> {
  return runBindingQueue.run(async () => {
    try {
      return await mutate();
    } catch (error) {
      const needsBinding =
        error instanceof OrcaCommandError &&
        (error.code === "consumer_fenced" ||
          error.code === "run_required" ||
          error.message.includes("consumer_fenced") ||
          error.message.includes("No Run is bound"));
      if (!needsBinding || runId === undefined) {
        throw error;
      }
      await client.runUse(runId);
      return await mutate();
    }
  });
}

/** `consumer_fenced` のメッセージから、バインド中の Run ID を拾う(診断用)。 */
export function extractBoundRun(message: string): string | undefined {
  return message.match(/bound to (run_[A-Za-z0-9_-]+)/)?.[1];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function pickString(source: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = str(source[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * ネストしたオブジェクト(task / dispatch / run など)の中まで ID を探しに行く。
 * orca の応答は `{ ok, result: { task: { taskId } } }` のように包まれるため、
 * unwrapResult 後にこれをかざす(深さ 2 まで、無限探索しない)。
 */
export function pickIdDeep(source: JsonObject, keys: readonly string[], depth = 0): string | undefined {
  const direct = pickString(source, keys);
  if (direct !== undefined || depth >= 2) {
    return direct;
  }
  for (const value of Object.values(source)) {
    if (isJsonObject(value)) {
      const nested = pickIdDeep(value, keys, depth + 1);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

/** poll 1 回で返す子タスクの上限(応答が膨らみすぎないための打ち切り)。 */
const MAX_CHILDREN = 20;

const ID_KEYS = ["taskId", "task_id", "id"] as const;const DISPATCH_ID_KEYS = ["dispatchId", "dispatch_id", "id"] as const;
/** task 行から dispatch id を拾うときのキー(`id` は task id なので含めない) */
const TASK_DISPATCH_KEYS = ["dispatch_id", "dispatchId"] as const;
const AGENT_KEYS = ["provider", "agentType", "agent_type", "agent", "agentId", "agentIdentity"] as const;
const TITLE_KEYS = ["task_title", "taskTitle", "title", "display_name", "displayName"] as const;
const CREATED_KEYS = ["created_at", "createdAt"] as const;
const COMPLETED_KEYS = ["completed_at", "completedAt", "finished_at", "finishedAt"] as const;
const UPDATED_KEYS = ["updated_at", "updatedAt", "last_heartbeat_at", "created_at"] as const;

/** orca の task-list 生の status → Job API の state。未知は unknown(生の値は rawStatus に残す)。 */
export function mapTaskState(rawStatus: string | undefined): JobState {
  switch (rawStatus?.toLowerCase()) {
    case "pending":
    case "ready":
    case "queued":
      return "queued";
    case "dispatched":
    case "in_progress":
    case "in-progress":
    case "running":
    case "working":
      return "running";
    case "blocked":
    case "waiting":
      return "blocked";
    case "completed":
    case "done":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** worker の生の状態(projection.outcome / workerState / dispatchStatus)→ 正規化 status。 */
export function mapWorkerStatus(raw: string | undefined): string {
  switch (raw?.toLowerCase()) {
    case "succeeded":
    case "completed":
    case "done":
      return "completed";
    case "failed":
    case "errored":
      return "failed";
    case "in_progress":
    case "in-progress":
    case "running":
    case "active":
    case "working":
    case "dispatched":
      return "running";
    case "unsupervised":
      // `dispatch` が採用したターミナルでエージェントが動いている状態
      return "running";
    case "released":
    case "retained":
    case "reclaimable":
    case "settled":
      return "settled";
    case "pending":
    case "queued":
    case "not_started":
      return "queued";
    case "blocked":
    case "waiting":
      return "blocked";
    default:
      return raw ?? "unknown";
  }
}

/** 応答から dispatch 配列(単一オブジェクトも含む)を取り出す。 */
export function extractDispatches(payload: JsonObject): JsonObject[] {
  const source = unwrapResult(payload);
  const raw = source["dispatches"] ?? source["dispatch"];
  if (Array.isArray(raw)) {
    return raw.filter(isJsonObject);
  }
  return isJsonObject(raw) ? [raw] : [];
}

export function extractWorkers(payload: JsonObject): JsonObject[] {
  const source = unwrapResult(payload);
  const raw = source["workers"] ?? source["agents"];
  return Array.isArray(raw) ? raw.filter(isJsonObject) : [];
}

export function extractGates(payload: JsonObject): JsonObject[] {
  const source = unwrapResult(payload);
  const raw = source["gates"];
  return Array.isArray(raw) ? raw.filter(isJsonObject) : [];
}

/**
 * worker 行(projection / stage / liveness 込み)を Job API 用の 1 行に正規化する(テスト対象)。
 * 実ペイロード: { dispatchId, taskId, workerState, dispatchStatus, agentTerminalHandle,
 *   terminalState, projection: { provider, outcome, stage: { activity }, liveness: { verdict },
 *   attention: { requiresAction } } }
 */
export function toWorkerRow(worker: JsonObject): JsonObject {
  const projection = isJsonObject(worker["projection"]) ? (worker["projection"] as JsonObject) : {};
  const stage = isJsonObject(projection["stage"]) ? (projection["stage"] as JsonObject) : {};
  const liveness = isJsonObject(projection["liveness"]) ? (projection["liveness"] as JsonObject) : {};
  const attention = isJsonObject(projection["attention"]) ? (projection["attention"] as JsonObject) : {};

  const rawStatus =
    pickString(worker, ["workerState", "worker_state", "workerStatus", "status", "state"]) ??
    pickString(projection, ["outcome"]);
  const outcome = pickString(projection, ["outcome"]);
  const row: JsonObject = {
    agent: pickString(worker, AGENT_KEYS) ?? pickString(projection, AGENT_KEYS) ?? null,
    status: mapWorkerStatus(outcome ?? rawStatus),
    rawStatus: rawStatus ?? null,
    outcome: outcome ?? null,
    dispatchId: pickString(worker, DISPATCH_ID_KEYS) ?? null,
    taskId: pickString(worker, ["taskId", "task_id"]) ?? null,
    terminalState: pickString(worker, ["terminalState", "terminal_state", "resourceState"]) ?? null,
    terminalHandle:
      pickString(worker, ["agentTerminalHandle", "agent_terminal_handle", "terminalHandle", "handle"]) ??
      null,
    worktreeId: pickString(worker, ["worktreeId", "worktree_id"]) ?? null,
    activity: pickString(stage, ["activity"]) ?? null,
    liveness: pickString(liveness, ["verdict"]) ?? null,
    observedAt: observedAtIso(isJsonObject(projection["evidence"]) ? projection["evidence"]["lastObservedAt"] : undefined),
  };
  if (typeof attention["requiresAction"] === "boolean") {
    row["requiresAttention"] = attention["requiresAction"];
  }
  if (Array.isArray(attention["categories"])) {
    row["attentionCategories"] = attention["categories"].filter((category) => typeof category === "string");
  }
  const updatedAt = worker["updatedAt"] ?? worker["lastOutputAt"] ?? worker["updated_at"];
  if (updatedAt !== undefined) {
    row["updatedAt"] = updatedAt;
  }
  return row;
}

/**
 * state だけでは見えない「いま何をしているか」を worker / gate から推定する(テスト対象)。
 * 根拠が無いときは starting に寄せる(過大な主張をしない)。
 */
export function estimatePhase(state: JobState, workers: JsonObject[], gates: JsonObject[]): JobPhase {
  if (state === "queued") {
    return "queued";
  }
  if (state === "completed") {
    return "finished";
  }
  if (state === "failed" || state === "cancelled") {
    return "failed";
  }
  const pendingGates = gates.filter((gate) => {
    const status = pickString(gate, ["status", "state"]);
    return status === undefined || status.toLowerCase() === "pending";
  });
  if (pendingGates.length > 0) {
    return "decision_gate";
  }
  // ゲートが無い blocked は人間の判断待ちとは限らない(Commander の blocked 報告など)
  if (state === "blocked") {
    return "blocked";
  }
  const statuses = workers.map((worker) => worker["status"]);
  const hasRunning = statuses.includes("running");
  const allSettled = workers.length > 0 && statuses.every((s) => s === "completed" || s === "failed");
  if (allSettled) {
    // task 側がまだ dispatched のまま = 完了の確定処理が済んでいない
    return "settling";
  }
  if (hasRunning) {
    return workers.length > 1 ? "implementation" : "implementation";
  }
  return "starting";
}

export type BlockedKind = "gate" | "task_report" | "agent_prompt" | "unknown";

const BLOCKED_HINTS: Record<BlockedKind, string> = {
  gate:
    "判断ゲートが pending。blockedReasons の question / options を確認し、承認/却下は orca_resolve_gate({ gateId, resolution, run }) — run には blockedReasons[].detail.runId(gates[].runId)を使う。sub-run 内のゲートは呼び出し元 Run と違う Run に属する",
  task_report:
    "Commander / 子タスクが blocked を報告している。blockedReasons の内容を読み、orca_send_message で指示するか orca_cancel_task で止める",
  agent_prompt:
    "エージェントが入力待ち(承認プロンプト、または Commander がターンを終えて待機中)。blockedReasons の detail.outputTail で内容を確認し、承認ならば pane で人間が答える(MCP からは解除できない)。待機中なら orca_send_message で指示するか、不要なら orca_cancel_task で止める",
  unknown:
    "blocked の理由が特定できない。orca_get_task_result と terminal の出力を確認する",
};

const BLOCKED_KIND_ORDER: BlockedKind[] = ["gate", "task_report", "agent_prompt", "unknown"];
const MAX_REASON_TEXT = 2000;
const MAX_ATTENTION_READS = 2;
const ATTENTION_READ_LINES = 30;
const ATTENTION_READ_CHARS = 1500;

const APPROVAL_PROMPT_PATTERN =
  /do you want to proceed|requires approval|\(y\/n\)|\[y\/n\]|yes, and don.t ask again|allow (this|once)|❯\s*1\.\s*yes/i;

/** 出力末尾が承認プロンプトらしいか(文言からの推定。確定情報ではない)。 */
export function looksLikeApprovalPrompt(text: string): boolean {
  return APPROVAL_PROMPT_PATTERN.test(text.split("\n").slice(-12).join("\n"));
}

const PROMPT_FALLBACK_LINES = 8;
const PROMPT_LOOKBACK_LINES = 25;

/**
 * 出力末尾から承認依頼の部分だけを切り出す(無ければ null)。
 * 最後に承認文言に当たる行を探し、直前の実線(─)の区切りまで遡る。区切りが無ければ手前 8 行。
 * 点線(╌)の長い区切りは短くして返す。
 */
export function extractApprovalPrompt(text: string): string | null {
  const lines = text.split("\n");
  let hit = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (APPROVAL_PROMPT_PATTERN.test(lines[i] ?? "")) {
      hit = i;
      break;
    }
  }
  if (hit < 0) {
    return null;
  }
  let start = Math.max(0, hit - PROMPT_FALLBACK_LINES);
  for (let i = hit; i >= Math.max(0, hit - PROMPT_LOOKBACK_LINES); i -= 1) {
    if (/^\s*─{10,}\s*$/.test(lines[i] ?? "")) {
      start = i + 1;
      break;
    }
  }
  return lines
    .slice(start)
    .map((line) => line.replace(/╌{4,}/g, "╌╌╌"))
    .join("\n")
    .trim();
}

/** 出力末尾のハッシュ。呼び出し側が前回値と比べて変化(= 動作中)を判定する。 */
export function outputHashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function observedAtIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function isPendingGate(gate: JsonObject): boolean {
  const status = pickString(gate, ["status", "state"]);
  return status === undefined || status.toLowerCase() === "pending";
}

/**
 * blocked の理由を kind 別に集める(読み取りのみ)。
 * gate / task_report は task-list と gate-list の内容だけで決まる。agent_prompt は worker-read を足す。
 */
export async function collectBlockedReasons(
  client: OrcaClient,
  input: {
    state: JobState;
    tasks: JsonObject[];
    gates: JsonObject[];
    workers: JsonObject[];
    rootTaskId: string;
  },
  warnings: string[],
): Promise<JsonObject[]> {
  const reasons: JsonObject[] = [];

  for (const gate of input.gates.filter(isPendingGate)) {
    reasons.push({
      kind: "gate",
      taskId: gate["taskId"] ?? null,
      summary: gate["question"] ?? null,
      // runId を添える: gate-resolve には --run が無く、orca_resolve_gate は run 必須。
      // 呼び出し側が blockedReasons だけで解決に必要な Run を決められるようにする。
      detail: { gateId: gate["id"] ?? null, runId: gate["runId"] ?? null, options: gate["options"] ?? null },
    });
  }

  for (const task of input.tasks) {
    if (mapTaskState(pickString(task, ["status", "state", "taskStatus"])) !== "blocked") {
      continue;
    }
    const report = preview(typeof task["result"] === "string" ? task["result"].trim() : null, MAX_REASON_TEXT);
    if (report !== null && report !== "") {
      reasons.push({ kind: "task_report", taskId: pickString(task, ID_KEYS) ?? null, summary: report });
    }
  }

  // 終端(completed / failed)や exited の worker に残った attention は拾わない。
  // Orca が requiresAction を立てない承認プロンプトもあるので、activity が waiting の worker も候補にし、
  // 出力末尾がプロンプトらしいときだけ採用する(flagged = Orca が attention を立てたもの)
  const candidates = input.workers
    .filter(
      (worker) =>
        worker["status"] !== "completed" &&
        worker["status"] !== "failed" &&
        worker["liveness"] !== "exited" &&
        (worker["requiresAttention"] === true || worker["activity"] === "waiting"),
    )
    .sort((a, b) => Number(b["requiresAttention"] === true) - Number(a["requiresAttention"] === true));
  const gateFound = reasons.some((reason) => reason["kind"] === "gate");
  if (candidates.length > 0 && (input.state === "blocked" || !gateFound)) {
    let reads = 0;
    for (const worker of candidates) {
      const flagged = worker["requiresAttention"] === true;
      const dispatchId = typeof worker["dispatchId"] === "string" ? (worker["dispatchId"] as string) : undefined;
      let output: string | null = null;
      if (dispatchId !== undefined && reads < MAX_ATTENTION_READS) {
        reads += 1;
        try {
          // auto は transcript(構造化メッセージ)を返し、承認プロンプトの画面が含まれないので terminal を指定する
          const read = unwrapResult(
            await client.workerRead({ dispatch: dispatchId, source: "terminal", limit: ATTENTION_READ_LINES }),
          );
          const text = extractOutputText(read).text;
          output = text === null ? null : text.length <= ATTENTION_READ_CHARS ? text : text.slice(-ATTENTION_READ_CHARS);
        } catch (error) {
          warnings.push(
            `worker ${dispatchId} の出力取得に失敗: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!flagged && (output === null || !looksLikeApprovalPrompt(output))) {
        continue;
      }
      reasons.push({
        kind: "agent_prompt",
        taskId: worker["taskId"] ?? null,
        summary: `worker ${dispatchId ?? "?"} が入力待ち: categories=${JSON.stringify(worker["attentionCategories"] ?? [])}, activity=${worker["activity"] ?? "unknown"}`,
        detail: {
          dispatchId: dispatchId ?? null,
          outputTail: output === null ? null : (extractApprovalPrompt(output) ?? output),
          outputHash: output === null ? null : outputHashOf(output),
          looksLikePrompt: output === null ? null : looksLikeApprovalPrompt(output),
          observedAt: worker["observedAt"] ?? null,
          activity: worker["activity"] ?? null,
        },
      });
    }
  }

  const stuckChild = input.tasks.some(
    (task) => mapTaskState(pickString(task, ["status", "state", "taskStatus"])) === "blocked",
  );
  if (reasons.length === 0 && (input.state === "blocked" || stuckChild)) {
    reasons.push({
      kind: "unknown",
      taskId: null,
      summary: "blocked だが gate / 報告 / attention のいずれも見つからない",
    });
  }
  // taskId が対象タスク(= Commander)なら commander、それ以外(子タスク)は child
  return reasons.map((reason) => ({
    ...reason,
    role: reason["taskId"] === null || reason["taskId"] === input.rootTaskId ? "commander" : "child",
  }));
}

function primaryBlockedKind(reasons: JsonObject[]): BlockedKind | undefined {
  return BLOCKED_KIND_ORDER.find((kind) => reasons.some((reason) => reason["kind"] === kind));
}

/** state に応じた次のアクション(呼び出し側が迷わないための手掛かり)。 */
export function nextActionHint(
  state: JobState,
  phase: JobPhase,
  workerCount = 0,
  blockedKind?: BlockedKind,
): string {
  if (blockedKind !== undefined && (state === "blocked" || state === "running" || state === "unknown")) {
    return BLOCKED_HINTS[blockedKind];
  }
  switch (state) {
    case "queued":
      // dispatch が無い queued は「Commander が起動していない」= 放置しても進まない。
      // worker-start 失敗(repo_not_found など)がここに着地するので、次の手を明示する。
      return workerCount === 0
        ? "Commander が未起動(dispatch 無し)。delegate の warnings を確認し、必要なら repo / commanderAgent を直して delegate し直すか orca_cancel_task で止める(放置すると queued のまま)"
        : "poll again; dispatch が未完了なら orca_get_task_status を再試行";
    case "running":
      return "poll again with orca_get_task_status";
    case "blocked":
      return phase === "decision_gate"
        ? "判断ゲートが pending(gates を参照)。承認/却下は orca_resolve_gate({ gateId, resolution, run }) で、run には gates[].runId を使う(sub-run のゲートは呼び出し元 Run と違う Run に属する)"
        : "poll again with orca_get_task_status";
    case "completed":
      return "call orca_get_task_result";
    case "failed":
    case "cancelled":
      return "call orca_get_task_result for the failure detail";
    default:
      return "poll again with orca_get_task_status";
  }
}

function preview(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

/** task-list 応答から対象タスク 1 件を探す(見つからなければ JobError)。 */
export function findTaskById(payload: JsonObject, taskId: string): JsonObject {
  const tasks = extractTasks(unwrapResult(payload));
  const found = tasks.find((task) => pickString(task, ID_KEYS) === taskId);
  if (found === undefined) {
    throw new JobError(
      "task_not_found",
      `タスク ${taskId} が見つかりません(run 指定が正しいか確認してください)`,
      { taskId, taskCount: tasks.length },
    );
  }
  return found;
}

/**
 * task-list 応答から対象タスクの**直接の子タスク**を取り出す。
 * Commander が task-create で分解した subtask は `parent_id` に親の ID を持つので、
 * poll 1 回で「Commander の下で何が起きているか」まで見せる(追加の CLI 呼び出しは不要)。
 */
export function findChildTasks(payload: JsonObject, taskId: string): JsonObject[] {
  const tasks = extractTasks(unwrapResult(payload));
  return tasks.filter((task) => pickString(task, ["parent_id", "parentId"]) === taskId);
}

/** 子タスクの応答を 1 行に正規化する(テスト対象)。 */
export function toChildRow(child: JsonObject, workers: JsonObject[], sourceRunId?: string | null): JsonObject {
  const rawStatus = pickString(child, ["status", "state", "taskStatus"]);
  return {
    taskId: pickString(child, ID_KEYS) ?? null,
    title: pickString(child, TITLE_KEYS) ?? null,
    state: mapTaskState(rawStatus),
    rawStatus: rawStatus ?? null,
    workers,
    resultPreview: preview(child["result"], 200),
    createdAt: child["created_at"] ?? child["createdAt"] ?? null,
    completedAt: child["completed_at"] ?? child["completedAt"] ?? null,
    // Commander が sub-run を作った場合、その子タスクは呼び出し元 Run には現れない。
    // どの Run から拾ったかを正直に載せる(呼び出し側が poll / cancel で使える)。
    sourceRunId: sourceRunId ?? null,
  };
}

/* ---------------------------------------------------------------------------
 * sub-run 観測(Commander が `run-create` で子 Run を作った場合の復元)
 *
 * 実測(2026-10-13 / orca 1.4.222):
 *  - Commander は自分の terminal から `run-create` を実行し、sub-run を作る。
 *    その `coordinator_handle` は **Commander の terminal handle そのもの**。
 *  - sub-run 内のタスクは `parent_id` が **sub-run 内で作った新しい root** を指す
 *    (呼び出し元 Run の Commander task を指さない)。だから `parent == taskId` だけ
 *    では 1 件も見つからない → 照合は handle 経由が正しい。
 *  - task-list は run スコープなので、呼び出し元 Run の poll / cancel は sub-run を丸ごと見失う。
 * --------------------------------------------------------------------------- */

/** 1 poll / cancel で照合する sub-run の上限(CLI 呼び出し数の抑制)。 */
export const MAX_SUB_RUNS = 3;
/** run-list から読む行数(応答は keyset cursor 付きの作成順)。 */
const SUB_RUN_SCAN_LIMIT = 50;
/** run-list のページング上限(1 ページ 50 件 × 5 = 250 行。live で 60+ 件の実測あり)。 */
const MAX_SCAN_PAGES = 5;
/** worker-list のページング上限(1 ページ 100 件 × 3)。実測で page.hasMore / nextCursor あり。 */
const MAX_WORKER_PAGES = 3;
/** 対象タスクよりこれ以前に作られた run は除外する(TZ 表記ゆれ吸収用の安全策)。 */
const SUB_RUN_CREATED_SKEW_MS = 24 * 60 * 60 * 1000;

const RUN_ID_KEYS = ["runId", "run_id", "id"] as const;
const COORDINATOR_HANDLE_KEYS = ["coordinator_handle", "coordinatorHandle"] as const;
const CREATED_BY_HANDLE_KEYS = ["created_by_terminal_handle", "createdByTerminalHandle"] as const;

/** run-list / run-show 応答から run 配列(単一オブジェクトも含む)を取り出す。 */
export function extractRuns(payload: JsonObject): JsonObject[] {
  const source = unwrapResult(payload);
  const raw = source["runs"] ?? source["items"];
  if (Array.isArray(raw)) {
    return raw.filter(isJsonObject);
  }
  const single = source["run"];
  return isJsonObject(single) ? [single] : [];
}

/** run 行を Job API 用の 1 行に正規化する(テスト対象)。 */
export function toRunRow(run: JsonObject): JsonObject {
  return {
    runId: pickString(run, RUN_ID_KEYS) ?? null,
    objective: pickString(run, ["objective"]) ?? null,
    coordinatorHandle: pickString(run, COORDINATOR_HANDLE_KEYS) ?? null,
    createdAt: run["created_at"] ?? run["createdAt"] ?? null,
    updatedAt: run["updated_at"] ?? run["updatedAt"] ?? null,
  };
}

function toEpoch(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * run-list から Commander 配下の sub-run を拾う(テスト対象)。
 *
 * 照合キーは `coordinator_handle`(= その Run を作成した coordinator の terminal handle)。
 *  - handle 無しは照合不能なので落とす(実測で 5 件中 2 件が null)。
 *  - 呼び出し元 Run 自身は除外する。
 *  - handle が Commander のもの(対象タスクの assignee / worker terminal)と一致しないものは除外。
 *  - 対象タスクより 24 分以上前に作られた run は除外する(terminal 再利用で古い Run が
 *    同じ handle を持つ事故を避ける。task-list の created_at はローカル表記、run-list は
 *    UTC 表記なので厳密比較はしない)。
 */
export function matchSubRuns(
  runs: JsonObject[],
  input: { callerRunId: string | null; handles: readonly string[]; taskCreatedAt?: unknown },
  limit: number = MAX_SUB_RUNS,
): JsonObject[] {
  const handles = new Set(input.handles.filter((handle) => typeof handle === "string" && handle.length > 0));
  if (handles.size === 0) {
    return [];
  }
  const taskEpoch = toEpoch(input.taskCreatedAt);
  const floor = taskEpoch === undefined ? undefined : taskEpoch - SUB_RUN_CREATED_SKEW_MS;

  const matched: JsonObject[] = [];
  for (const run of runs) {
    const row = toRunRow(run);
    const runId = row["runId"];
    const handle = row["coordinatorHandle"];
    if (typeof runId !== "string" || typeof handle !== "string") {
      continue; // handle 無しは照合不能
    }
    if (input.callerRunId !== null && runId === input.callerRunId) {
      continue; // 呼び出し元 Run 自身
    }
    if (!handles.has(handle)) {
      continue;
    }
    const created = toEpoch(row["createdAt"]);
    if (created !== undefined && floor !== undefined && created < floor) {
      continue;
    }
    matched.push(row);
  }
  return matched.slice(0, MAX_SUB_RUNS);
}

/**
 * sub-run の root 配列から「Commander が作った root」を 1 件に絞る(複数 root は信頼度を落とす)。
 * 実測では 1 件(task_a9c5f6f06805)。複数ある = 同一 handle が複数の job を作っている可能性。
 */
function primaryRoot(roots: JsonObject[]): JsonObject | null {
  return roots.length === 1 ? (roots[0] as JsonObject) : null;
}

/* ---------------------------------------------------------------------------
 * sub-run の所有関係(review9 §4 / §6 の方針)
 *
 * handle 一致だけでは破壊的操作の対象にしない。実測で使えた来歴(1.4.222):
 *   task 行  : created_by_terminal_handle / created_by_pane_key(tabId:leafId)
 *              created_by_process_incarnation(ptyId:incarnationId)
 *   terminal : handle / tabId / leafId / ptyId / incarnationId
 * 実測一致(run_8d1d20524d42 の root と Commander terminal):
 *   created_by_pane_key          == tabId:leafId
 *   created_by_process_incarnation == ptyId:incarnationId
 * objective のマーカーは誰でも書けるので「発見の候補」に留め、来歴と組み合わせて判定する。
 * --------------------------------------------------------------------------- */

/** Commander Prompt に書き込む objective マーカーの接頭辞(両者は同じ文言を使う)。 */
export const SUB_RUN_MARKER_PREFIX = "orca-mcp-parent:";

const PANE_KEY_KEYS = ["created_by_pane_key", "createdByPaneKey"] as const;
const PROCESS_INCARNATION_KEYS = ["created_by_process_incarnation", "createdByProcessIncarnation"] as const;

export type SubRunOwnership = "verified" | "probable" | "unverified" | "conflicting";

/** 来歴照合に使う terminal 1 行の identity(terminal list から作る)。 */
export interface TerminalIdentity {
  handle: string;
  tabId: string | null;
  leafId: string | null;
  ptyId: string | null;
  incarnationId: string | null;
}

/** terminal list 応答から handle → identity の対応表を作る(テスト対象)。 */
export function buildTerminalIdentities(payload: JsonObject): Map<string, TerminalIdentity> {
  const source = unwrapResult(payload);
  const raw = source["terminals"] ?? source["items"];
  const rows = Array.isArray(raw) ? raw.filter(isJsonObject) : [];
  const identities = new Map<string, TerminalIdentity>();
  for (const row of rows) {
    const handle = pickString(row, ["handle", "terminalHandle", "terminal_handle"]);
    if (handle === undefined) {
      continue;
    }
    identities.set(handle, {
      handle,
      tabId: pickString(row, ["tabId", "tab_id"]) ?? null,
      leafId: pickString(row, ["leafId", "leaf_id"]) ?? null,
      ptyId: pickString(row, ["ptyId", "pty_id"]) ?? null,
      incarnationId: pickString(row, ["incarnationId", "incarnation_id"]) ?? null,
    });
  }
  return identities;
}

/**
 * objective へ書き込まれた親 Job マーカーを取り出す(テスト対象)。
 *
 * 書式: `orca-mcp-parent: run=<runId> task=<taskId>`(task 省略可)。
 * マーカーは**誰でも書ける**ので、これだけで所有を確定してはならない(review9 §4)。
 */
export function parseParentMarker(objective: unknown): { runId: string | null; taskId: string | null } | null {
  if (typeof objective !== "string") {
    return null;
  }
  const index = objective.indexOf(SUB_RUN_MARKER_PREFIX);
  if (index < 0) {
    return null;
  }
  const tail = objective.slice(index + SUB_RUN_MARKER_PREFIX.length, index + SUB_RUN_MARKER_PREFIX.length + 200);
  const run = /run\s*=\s*([A-Za-z0-9_-]+)/.exec(tail);
  const task = /task\s*=\s*([A-Za-z0-9_-]+)/.exec(tail);
  return { runId: run?.[1] ?? null, taskId: task?.[1] ?? null };
}

export interface OwnershipVerdict {
  ownership: SubRunOwnership;
  cancelEligible: boolean;
  verificationReasons: string[];
  source: "explicit" | "provenance" | "handle" | "none";
}

/**
 * sub-run の所有関係を判定する(テスト対象)。
 *
 * verified  : coordinator_handle 一致 + pane key / incarnation の 2 系統が一致、矛盾なし
 * probable  : handle 一致のみ(来歴の確認が取れない)= 破壊的操作には使わない
 * unverified: handle 一致が取れない / root が特定できない
 * conflicting: 来歴が矛盾する、またはマーカーが別の Run を指す
 */
export function classifySubRunOwnership(input: {
  run: JsonObject;
  roots: JsonObject[];
  handles: readonly string[];
  callerRunId: string | null;
  terminals: Map<string, TerminalIdentity>;
}): OwnershipVerdict {
  const handle = pickString(input.run, COORDINATOR_HANDLE_KEYS);
  if (typeof handle !== "string" || !input.handles.includes(handle)) {
    return {
      ownership: "unverified",
      cancelEligible: false,
      verificationReasons: ["coordinator_handle が Commander の handle と一致しない"],
      source: "none",
    };
  }
  const reasons: string[] = ["coordinator_handle 一致"];

  const marker = parseParentMarker(input.run["objective"]);
  if (marker !== null) {
    if (input.callerRunId !== null && marker.runId !== null && marker.runId !== input.callerRunId) {
      return {
        ownership: "conflicting",
        cancelEligible: false,
        verificationReasons: [...reasons, `objective のマーカーが別の Run(${marker.runId})を指す`],
        source: "explicit",
      };
    }
    reasons.push(marker.taskId !== null ? "objective マーカーの親 run / task が一致" : "objective マーカーの親 Run が一致");
  }

  const root = primaryRoot(input.roots);
  if (root === null) {
    return {
      ownership: "unverified",
      cancelEligible: false,
      verificationReasons: [...reasons, `root が 1 件に特定できない(${input.roots.length} 件)`],
      source: marker !== null ? "explicit" : "handle",
    };
  }

  const createdBy = pickString(root, CREATED_BY_HANDLE_KEYS);
  if (createdBy !== undefined && createdBy !== handle) {
    return {
      ownership: "conflicting",
      cancelEligible: false,
      verificationReasons: [...reasons, "root の created_by_terminal_handle が Commander の handle と違う"],
      source: "provenance",
    };
  }

  const identity = input.terminals.get(handle);
  let matches = 0;
  let conflicts = 0;
  const paneKey = pickString(root, PANE_KEY_KEYS);
  if (paneKey !== undefined) {
    if (identity?.tabId !== null && identity?.leafId !== null && identity !== undefined) {
      if (paneKey === `${identity.tabId}:${identity.leafId}`) {
        matches += 1;
        reasons.push("pane key(tabId:leafId)一致");
      } else {
        conflicts += 1;
      }
    }
  }
  const incarnation = pickString(root, PROCESS_INCARNATION_KEYS);
  if (incarnation !== undefined) {
    if (identity?.ptyId !== null && identity?.incarnationId !== null && identity !== undefined) {
      if (incarnation === `${identity.ptyId}:${identity.incarnationId}`) {
        matches += 1;
        reasons.push("process incarnation(ptyId:incarnationId)一致");
      } else {
        conflicts += 1;
      }
    }
  }

  if (conflicts > 0) {
    return {
      ownership: "conflicting",
      cancelEligible: false,
      verificationReasons: [...reasons, `来歴の不一致が ${conflicts} 件`],
      source: "provenance",
    };
  }
  if (matches >= 2) {
    return { ownership: "verified", cancelEligible: true, verificationReasons: reasons, source: "provenance" };
  }
  return {
    ownership: "probable",
    cancelEligible: false,
    verificationReasons: [...reasons, "pane key / incarnation の来歴確認が取れない"],
    source: marker !== null ? "explicit" : "handle",
  };
}

/**
 * sub-run の task 配列から、Commander 配下の **root**(sub-run 内で親を持たない行)を拾う(テスト対象)。
 *
 * 実測: Commander は sub-run 内で新しい root task を作り、子 6 件はその root を指す。
 * 呼び出し元 Run の Commander task を指す `parent_id` は使われないので、
 * 「sub-run 内で親が居ない + Commander の handle が作った」で root を特定する。
 */
export function selectSubRunRoots(tasks: JsonObject[], handles: readonly string[]): JsonObject[] {
  const handleSet = new Set(handles.filter((handle) => typeof handle === "string" && handle.length > 0));
  const ids = new Set(
    tasks.map((task) => pickString(task, ID_KEYS)).filter((id): id is string => id !== undefined),
  );
  return tasks.filter((task) => {
    if (pickString(task, ID_KEYS) === undefined) {
      return false;
    }
    const parent = pickString(task, ["parent_id", "parentId"]);
    if (parent !== undefined && ids.has(parent)) {
      return false; // sub-run 内に親がいる = root ではない(部分木側で拾える)
    }
    const createdBy = pickString(task, CREATED_BY_HANDLE_KEYS);
    return createdBy !== undefined && handleSet.has(createdBy);
  });
}

interface SubRunCapture {
  /** 監査用に、何を sub-run として見つけたか(run 行 + 所有判定)。 */
  subRuns: JsonObject[];
  /** 呼び出し元タスクの direct children として見せる行(sub-run の root)。 */
  childTasks: JsonObject[];
  /** cancel cascade 用の部分木(sub-run root + その子孫、post-order)。runId 付き。 */
  subtreeTasks: Array<JsonObject & { __runId?: string }>;
  /** sub-run 内の worker 行(部分木に紐づくものだけ)。 */
  workers: JsonObject[];
  /** sub-run 内の gate(部分木に紐づくものだけ)。 */
  gates: JsonObject[];
  warnings: string[];
  /** run-list を cursor で読み切ったか(打ち切ったら false)。 */
  scanComplete: boolean;
  /** run-list を何ページ読んだか。 */
  scanPageCount: number;
  /** 走査した run 行数(照合前のスキャン総数)。 */
  scanRunCount: number;
  /** 1 ページの limit。 */
  scanLimit: number;
  /** 照合が MAX_SUB_RUNS で打ち切られたか。 */
  subRunsTruncated: boolean;
  /** 見つけた sub-run の所有関係がすべて verified か(0 件なら true)。 */
  ownershipComplete: boolean;
  /** sub-run 側の worker-list を読み切ったか(打ち切ったら false)。 */
  workerScanComplete: boolean;
  /** 探索の前提となる run-list が読めなかったか(cancel は preflight で断る)。 */
  scanFailed: boolean;
}

const EMPTY_CAPTURE: SubRunCapture = {
  subRuns: [],
  childTasks: [],
  subtreeTasks: [],
  workers: [],
  gates: [],
  warnings: [],
  scanComplete: true,
  scanPageCount: 0,
  scanRunCount: 0,
  scanLimit: SUB_RUN_SCAN_LIMIT,
  subRunsTruncated: false,
  ownershipComplete: true,
  workerScanComplete: true,
  scanFailed: false,
};

/** ページ応答の次カーソル(run-list は result 直下、worker-list は page.nextCursor: 実測)。 */
function nextCursorOf(payload: JsonObject): string | null {
  const page = isJsonObject(payload["page"]) ? (payload["page"] as JsonObject) : null;
  return pickString(payload, ["nextCursor", "cursor"]) ?? (page === null ? null : pickString(page, ["nextCursor", "cursor"]) ?? null);
}

/** ページ応答の「まだ次がある」(worker-list の page.hasMore: 実測)。 */
function hasMoreOf(payload: JsonObject): boolean {
  const page = isJsonObject(payload["page"]) ? (payload["page"] as JsonObject) : null;
  return page?.["hasMore"] === true;
}

type ScanStopReason = "complete" | "page_limit" | "has_more_without_cursor" | "cursor_repeat";

interface PagedScan {
  rows: JsonObject[];
  pages: number;
  complete: boolean;
  stopReason: ScanStopReason;
}

/**
 * cursor ページングの共通実装(P3)。
 *
 * 完走したかどうかを**必ず**返す(上限到達で黙って部分結果を返さない)。
 * `page.hasMore: true` なのに `nextCursor` が無い、同じ cursor が戻る、といった
 * 異常も「打ち切り」として出す(打ち切りを完走として扱うと、cancel が
 * 「全部止めた」と誤報する。worker 行の取りこぼしはそのまま停止漏れになる)。
 */
async function scanPaged(
  fetchPage: (cursor: string | undefined) => Promise<JsonObject>,
  extract: (payload: JsonObject) => JsonObject[],
  maxPages: number,
): Promise<PagedScan> {
  const rows: JsonObject[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchPage(cursor);
    rows.push(...extract(payload));
    pages += 1;
    const next = nextCursorOf(payload);
    if (next === null) {
      return hasMoreOf(payload)
        ? { rows, pages, complete: false, stopReason: "has_more_without_cursor" }
        : { rows, pages, complete: true, stopReason: "complete" };
    }
    if (seen.has(next)) {
      return { rows, pages, complete: false, stopReason: "cursor_repeat" };
    }
    seen.add(next);
    cursor = next;
  }
  return { rows, pages, complete: false, stopReason: "page_limit" };
}

const SCAN_STOP_TEXT: Record<ScanStopReason, string> = {
  complete: "",
  page_limit: "ページ上限に到達",
  has_more_without_cursor: "hasMore: true に対して nextCursor が無い",
  cursor_repeat: "同じ cursor が戻った(ループ)",
};

/**
 * run-list を cursor で読み集める(P3: 1 ページだけ見て「無い」と判定しない)。
 * 実測で live の run-list は limit 60 で 60 件 + nextCursor を返す = 打ち切りは現実に起きる。
 */
async function scanRunRows(client: OrcaClient): Promise<PagedScan> {
  return scanPaged(
    async (cursor) => unwrapResult(await client.runList({ limit: SUB_RUN_SCAN_LIMIT, cursor })),
    (payload) => extractRuns(payload),
    MAX_SCAN_PAGES,
  );
}

/**
 * worker-list をページングして全行読む(worker-list は 100 件で page.hasMore を返す: 実測)。
 *
 * 完走判定を返す: cancel の preflight と停止後検証は、打ち切りのときに
 * 「完全停止した」と宣言してはならない(review10 §1)。
 */
async function scanWorkerRows(client: OrcaClient, runId: string): Promise<PagedScan> {
  return scanPaged(
    async (cursor) => unwrapResult(await client.workerList({ run: runId, limit: 100, cursor })),
    (payload) => extractWorkers(payload),
    MAX_WORKER_PAGES,
  );
}

/**
 * Commander が自作した sub-run を読み集める(**読み取りだけ**)。
 *
 * 失敗しても poll / cancel / result は壊さない(run-list が読めなければ warning だけ添える)。
 * 呼び出し元 Run には現れない配下を拾うのが目的なので、`sourceRunId` を全結果に載せる。
 * 所有関係(P2)とスキャンの完全性(P3)を応答に載せ、破壊的操作の対象は cancel 側で絞る。
 */
async function captureSubRuns(
  client: OrcaClient,
  input: {
    callerRunId: string | null;
    handles: readonly string[];
    taskCreatedAt?: unknown;
    enabled: boolean;
  },
): Promise<SubRunCapture> {
  if (!input.enabled || typeof client.runList !== "function" || input.handles.length === 0) {
    return EMPTY_CAPTURE;
  }

  const warnings: string[] = [];
  let rows: JsonObject[];
  let pages = 0;
  let scanComplete = false;
  let scanStopReason: ScanStopReason = "complete";
  try {
    const scanned = await scanRunRows(client);
    rows = scanned.rows;
    pages = scanned.pages;
    scanComplete = scanned.complete;
    scanStopReason = scanned.stopReason;
  } catch (error) {
    // 探索の前提が読めない = 「sub-run は無い」とは言えない。cancel 側が preflight で断れるようにする。
    return {
      ...EMPTY_CAPTURE,
      scanComplete: false,
      scanFailed: true,
      warnings: [`sub-run 探索の run-list に失敗: ${failureLine(error)}`],
    };
  }
  if (!scanComplete) {
    warnings.push(
      `sub-run 探索を ${pages} ページ(1 ページ ${SUB_RUN_SCAN_LIMIT} 件)で打ち切りました(${SCAN_STOP_TEXT[scanStopReason]})`,
    );
  }

  const matchedAll = matchSubRuns(
    rows,
    { callerRunId: input.callerRunId, handles: input.handles, taskCreatedAt: input.taskCreatedAt },
    MAX_SUB_RUNS + 1,
  );
  const subRunsTruncated = matchedAll.length > MAX_SUB_RUNS;
  const matched = matchedAll.slice(0, MAX_SUB_RUNS);
  if (subRunsTruncated) {
    warnings.push(`sub-run の照合を ${MAX_SUB_RUNS} 件で打ち切りました(照合候補 ${matchedAll.length} 件)`);
  }
  if (matched.length === 0) {
    return { ...EMPTY_CAPTURE, scanComplete, scanPageCount: pages, scanRunCount: rows.length, subRunsTruncated, warnings };
  }

  // 来歴(pane key / incarnation)の対応表。terminal list が読めなければ verified にはしない。
  let terminals = new Map<string, TerminalIdentity>();
  if (typeof client.terminalList === "function") {
    try {
      terminals = buildTerminalIdentities(unwrapResult(await client.terminalList({ limit: 200 })));
    } catch (error) {
      warnings.push(`来歴照合の terminal list に失敗: ${failureLine(error)}`);
    }
  }

  const capture: SubRunCapture = {
    ...EMPTY_CAPTURE,
    subRuns: [],
    childTasks: [],
    subtreeTasks: [],
    workers: [],
    gates: [],
    warnings,
    scanComplete,
    scanPageCount: pages,
    scanRunCount: rows.length,
    subRunsTruncated,
  };
  for (const run of matched) {
    const runId = run["runId"] as string;
    try {
      const list = unwrapResult(await client.taskList({ run: runId, brief: false }));
      const tasks = extractTasks(list);
      const roots = selectSubRunRoots(tasks, input.handles);
      if (roots.length === 0) {
        capture.subRuns.push({
          ...run,
          taskCount: tasks.length,
          rootTaskIds: [],
          ownership: "unverified",
          cancelEligible: false,
          verificationReasons: ["sub-run 内に Commander の handle が作った root が見つからない"],
          discoverySource: "none",
        });
        continue;
      }
      const verdict = classifySubRunOwnership({
        run,
        roots,
        handles: input.handles,
        callerRunId: input.callerRunId,
        terminals,
      });
      capture.subRuns.push({
        ...run,
        taskCount: tasks.length,
        rootTaskIds: roots.map((row) => pickString(row, ID_KEYS) ?? null),
        ownership: verdict.ownership,
        cancelEligible: verdict.cancelEligible,
        verificationReasons: verdict.verificationReasons,
        discoverySource: verdict.source,
      });

      const subtreeIds = new Set<string>();
      for (const root of roots) {
        const rootId = pickString(root, ID_KEYS) as string;
        capture.childTasks.push({ ...root, __runId: runId });
        for (const row of collectDescendants({ tasks }, rootId)) {
          const id = pickString(row, ID_KEYS);
          if (id === undefined || subtreeIds.has(id)) {
            continue;
          }
          subtreeIds.add(id);
          capture.subtreeTasks.push({ ...row, __runId: runId });
        }
      }

      const workerScan = await scanWorkerRows(client, runId);
      if (!workerScan.complete) {
        capture.workerScanComplete = false;
        warnings.push(
          `sub-run ${runId} の worker-list を ${workerScan.pages} ページで打ち切りました(${SCAN_STOP_TEXT[workerScan.stopReason]})`,
        );
      }
      for (const row of workerScan.rows.map(toWorkerRow)) {
        const taskId = row["taskId"];
        if (typeof taskId === "string" && subtreeIds.has(taskId)) {
          capture.workers.push(row);
        }
      }

      const gatesPayload = unwrapResult(await client.gateList({ run: runId }));
      for (const gate of extractGates(gatesPayload)) {
        const gateTask = pickString(gate, ["task_id", "taskId"]);
        if (gateTask === undefined || subtreeIds.has(gateTask)) {
          // `__runId`: 照合した sub-run 名義(gate 行に run_id が無い CLI 版向けの補完用)。
          capture.gates.push({ ...gate, __runId: runId });
        }
      }
    } catch (error) {
      warnings.push(`sub-run ${runId} の読み集めに失敗: ${failureLine(error)}`);
    }
  }
  capture.ownershipComplete = capture.subRuns.every((row) => row["ownership"] === "verified");
  return capture;
}

/** poll / cancel で「Commander の terminal handle」の候補を揃える(sub-run 照合キー)。 */
function commanderHandles(task: JsonObject, workers: JsonObject[]): string[] {
  const handles = new Set<string>();
  const assignee = pickString(task, ["assignee_handle", "assigneeHandle"]);
  if (assignee !== undefined) {
    handles.add(assignee);
  }
  for (const worker of workers) {
    const handle = worker["terminalHandle"];
    if (typeof handle === "string" && handle.length > 0) {
      handles.add(handle);
    }
  }
  return [...handles];
}

/**
 * gate 行を Job API 用の 1 行に正規化する(poll / sub-run 共通)。
 *
 * `runId` は**必須で載せる**。`gate-resolve` には `--run` が無く(Run スコープは
 * 呼び出し元の binding で決まる)、`orca_resolve_gate` は `run` 必須なので、
 * 呼び出し側が「どの Run のゲートか」を分かっていなければならない。
 * 実測: sub-run の gate は `gate-list --run <sub-run>` でしか見えない
 * (呼び出し元 Run には 0 件)ので、runId 無しでは解決に使える Run が決まらない。
 * CLI 行の `run_id` を優先し、無いときは照合した Run 名義(第 2 引数)で補う。
 */
function toGateRow(gate: JsonObject, fallbackRunId?: string | null): JsonObject {
  return {
    id: pickString(gate, ["gateId", "gate_id", "id"]) ?? null,
    runId: pickString(gate, ["runId", "run_id", "run"]) ?? fallbackRunId ?? null,
    taskId: pickString(gate, ["task_id", "taskId"]) ?? null,
    status: pickString(gate, ["status", "state"]) ?? null,
    question: preview(gate["question"], MAX_REASON_TEXT),
    options: gate["options"] ?? null,
  };
}

/**
 * worktree 名を組み立てる(英数字に落とし、末尾に短 ID を足す)。
 * 公開経路(worker-start)は worktree 名を CLI 側に決めさせるため、これは
 * 内部用の足場(`orca_delegate` 系)で worktree を明示するときのヘルパー。
 */
export function buildWorktreeName(title: string | undefined, spec: string): string {
  const base = `${title ?? ""} ${spec}`.trim();
  const ascii = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  const suffix = Date.now().toString(36).slice(-4);
  return `${ascii.length >= 3 ? ascii : "task"}-${suffix}`;
}

export interface DelegateTaskInput {
  spec: string;
  title?: string;
  /** 起動する Commander Agent。作業ワーカーを選ぶのは Commander 側なので、ここは Commander の選択。 */
  commanderAgent?: string;
  repo?: string;
  run?: string;
  deps?: string[];
  parent?: string;
  /** Commander へ課する制約。spec の Constraints 欄に箇条書きで入る。 */
  constraints?: string[];
}

/**
 * Commander へ渡す固定プロンプト。
 *
 * 最後の節は Orca 公式の推奨そのもの: orchestration state を変更する前に
 * `orca skills get orchestration --full` で**現在のバージョンに合った guide**
 * を読み込ませる(CLI flag はバージョンで変わるため、記憶した構文を使わせない)。
 */
export const COMMANDER_PROMPT = `You are the lead coding orchestrator (Commander) for this task.

Goal:
{{goal}}

Repository:
{{repo}}

Constraints:
{{constraints}}

Before performing orchestration mutations, load the current version-matched
orchestration guide with:

  orca skills get orchestration --full

Follow that guide rather than relying on remembered CLI syntax. Use supervised
workers started with worker-start, and tracked tasks created with task-create,
for delegated work. Prefer parallel waves of independent tasks over deep chains.

If loading the guide is blocked by a tool-permission prompt you cannot answer,
do not sit waiting on it: fall back to "orca orchestration --help" and the
per-command "--help" for the syntax you need, and note the fallback in your
report. A worker that stalls on an unanswerable prompt blocks the whole job.

Responsibilities:
1. Inspect the repository and break the goal into well-scoped subtasks.
2. Delegate independent work to supervised workers, preferably in parallel.
3. Review worker outputs and diffs, request corrections, and run applicable tests.
4. Do not merge, push, deploy, delete branches, or modify production resources without an explicit approval gate.
5. Report completed work, tests, changed files, and unresolved risks.

Gate ownership:
You own every human-facing decision gate. Workers must not create gates for
human approval — a worker that needs approval escalates to you, and you create
the gate on your own task and resolve it when the human answers. Create gates
inside {{runId}} so the caller can observe and resolve them.

If gate-create fails: check the Run binding, retry it once safely, and if it
still fails, stop the approval-requiring operation, report the exact error, and
wait for correction or explicit intervention. Never proceed as if approval had
been granted, and never substitute your own judgement for a missing gate.

Run ownership and sub-run policy:
The caller polls, collects results and cancels through exactly ONE Run: {{runId}}.
Your task lives inside it — its id is in your dispatch preamble, and you can
confirm it with: orca orchestration task-list --run {{runId}} --json

Reuse that Run for ordinary child tasks, supervised workers, and decision gates:

  orca orchestration task-create --run {{runId}} --parent <your task id> --spec ...
  orca orchestration worker-start --run {{runId}} --task <child task id> --agent <worker agent>

Before any run-scoped operation, verify the current binding and bind to the
existing Run when appropriate:

  orca orchestration run-use --id {{runId}} --json

Do not create a new Run merely because the current terminal has no bound Run.
Never create a Run to bypass a nested worker depth limit, a circuit-broken
dispatch, a failed dispatch, or a missing Run binding: the version-matched guide
says a new Run does not reset depth and must not route around those boundaries.

A worker acting as an autonomous coordinator may create and manage a child Run
when the guide you loaded supports that shape. Treat legacy Run takeover
(run-use --takeover-legacy) as a separate operation — it is not permission to
create a new Run.

When you create a child Run:
1. Keep the parent Run id and parent task id unchanged.
2. Record the new Run id.
3. Put this marker at the start of the child Run objective so the caller can
   associate it with this job:  orca-mcp-parent: run={{runId}} task=<your task id>
4. Report the child Run id and its relationship to this job in your final report.
5. Finish every task inside it, so the caller's poll and cancel cover it.

Completion boundary:
Before declaring success, verify that every delegated child task has reached a
terminal state and inspect its result. Do not report completion while any child
task is still running, blocked, failed, or unaccounted for.

Do not mark the parent task successful if any required child task failed.
Resolve, retry, replace, or explicitly report the failure first.

Every subtask spec you create must be self-contained and name the target, the
change, the constraints, the ownership boundary, and the observable acceptance.`;

const DEFAULT_CONSTRAINTS = ["Preserve existing APIs and project conventions."];

/** 未注入のプレースホルダ検出用({{runId}} 等は複数箇所に出るので global で置換する)。 */
const PLACEHOLDER_PATTERN = /\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g;

/**
 * Commander 用の spec を組み立てる(テスト対象)。
 *
 * `{{runId}}` は task-create の**前**から分かっている値なので注入できる。
 * `{{taskId}}` は task-create の後にしか決まらず、`task-update` に `--spec` が無い
 * (実機 help 実測: --id / --status / --result / --run / --from / --retry-request のみ)
 * ため注入しない — Commander 自身に dispatch preamble と task-list で確認させる。
 * 未注入のプレースホルダは `leaked` で返す(spec に文字列を残さない)。
 */
export function commanderSpec(
  input: DelegateTaskInput,
  runId: string,
): { spec: string; leaked: string[] } {
  const constraints =
    input.constraints !== undefined && input.constraints.length > 0
      ? input.constraints.map((line) => `- ${line}`).join("\n")
      : DEFAULT_CONSTRAINTS.map((line) => `- ${line}`).join("\n");

  let spec = COMMANDER_PROMPT.replace(PLACEHOLDER_PATTERN, (token) => {
    switch (token) {
      case "{{goal}}":
        return input.spec;
      case "{{repo}}":
        return input.repo ?? "the current repository";
      case "{{constraints}}":
        return constraints;
      case "{{runId}}":
        return runId;
      default:
        return token;
    }
  });

  const leaked = [...new Set(spec.match(PLACEHOLDER_PATTERN) ?? [])];
  if (leaked.length > 0) {
    // プレースホルダを Commander の目に晒すと自行解釈を招く(今回の不具合の根)。
    spec = spec.replace(PLACEHOLDER_PATTERN, "(unavailable)");
  }
  return { spec, leaked };
}

export interface TaskStatusInput {
  taskId: string;
  run?: string;
  /** 既定 true: Commander が自作した sub-run の配下も children / gates に集約する。 */
  includeSubRuns?: boolean;
}

export interface TaskResultInput {
  taskId: string;
  run?: string;
  outputLimit?: number;
  /** 既定 false: Commander だけ読む。true にすると子タスクの成果と出力も集約する。 */
  includeChildren?: boolean;
  /** 既定 true: Commander が自作した sub-run の子タスクも集約対象に含める。 */
  includeSubRuns?: boolean;
}

function runIdOf(payload: JsonObject): string | undefined {
  return pickIdDeep(unwrapResult(payload), ["runId", "run_id", "id"]);
}

/** 失敗を 1 行の warning に落とす(CLI 側の code を優先して載せる)。 */
function failureLine(error: unknown): string {
  if (error instanceof OrcaCommandError) {
    return `[${error.code}] ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * submit: ゴールを Commander に渡す(この API の唯一の意味)。
 *
 * 手順は run-create(run 未指定時) → task-create(Commander 用の指示を付与) →
 * worker-start(supervised worker として Commander を起動)。
 * worker-start に失敗してもタスクは存在するので state: "queued" + warnings で返す
 * (例外にしてタスクを消さない)。完了は待たない。
 */
export async function delegateTask(
  client: OrcaClient,
  input: DelegateTaskInput,
): Promise<JsonObject> {
  const warnings: string[] = [];
  const commanderAgent = input.commanderAgent ?? "codex";

  // 1) Run: 呼び出し側が指定しなければ新規に作成する(MCP 側はターミナルバインドを持たない)。
  let runId: string | undefined = input.run;
  if (runId === undefined) {
    const objective = `${input.title ?? input.spec}`.slice(0, 120);
    const created = await client.runCreate(objective);
    runId = runIdOf(created);
    if (runId === undefined) {
      throw new JobError("run_create_failed", "run-create から Run ID を取得できませんでした", created);
    }
  }

  // 2) task-create(ここが成功すれば Job は成立する)。Commander 経路では spec を固定プロンプトで包む。
  const built = commanderSpec(input, runId);
  if (built.leaked.length > 0) {
    warnings.push(
      `Commander spec に未注入のプレースホルダがありました: ${built.leaked.join(", ")} — '(unavailable)' に置き換えました`,
    );
  }
  const task = await runMutation(client, runId, () =>
    client.taskCreate({
      spec: built.spec,
      title: input.title,
      deps: input.deps,
      parent: input.parent,
      run: runId,
    }),
  );
  const taskId = pickIdDeep(unwrapResult(task), ID_KEYS);
  if (taskId === undefined) {
    throw new JobError("task_id_missing", "task-create の応答からタスク ID を取得できませんでした", task);
  }

  // 3) worker-start で Commander を起動する(新規 child worktree の supervised worker)。
  try {
    const started = await runMutation(client, runId, () =>
      client.workerStart({
        task: taskId,
        worktree: "new-child",
        agent: commanderAgent,
        name: input.title,
        repo: input.repo,
        run: runId,
      }),
    );
    const startedResult = unwrapResult(started);
    const dispatchId = pickIdDeep(startedResult, DISPATCH_ID_KEYS) ?? null;
    // worker-start は receipt を返す。agent_readiness を通過しないと state: "failed" になり、
    // この dispatch 経由の worker_done は使えない(実測: launch token が記録されない起動コマンド)。
    // タスクは生きているので queued + 正直な warning で返す(例外化して消さない)。
    const receiptState = pickString(startedResult, ["state"]);
    if (receiptState === "failed") {
      const stage = pickString(startedResult, ["failedStage", "stage"]) ?? "unknown";
      const lastError = pickString(startedResult, ["lastError"]) ?? "unknown";
      warnings.push(
        `worker-start receipt state=failed stage=${stage} lastError=${lastError} — ` +
          `起動した worker が readiness を通過していません(dispatch ${dispatchId ?? "なし"})。` +
          `この dispatch 経由の worker_done は使えないので、worker 側の報告は task-update に落ちます。` +
          `agentCmdOverrides を向いている場合は起動コマンドの launch token が記録されません(README 参照)`,
      );
      return {
        taskId,
        state: "queued",
        runId,
        commander: true,
        commanderAgent,
        dispatchId,
        target: { kind: "supervised_worker", worktree: "new-child", agent: commanderAgent },
        warnings,
        nextAction:
          `orca_get_task_status({ taskId: ${taskId}, run: ${runId} }) で確認。` +
          `readiness 失敗を放置しない: worker-release して起動コマンド設定を直すか、` +
          `報告経路を task-update にした worker として扱う`,
      };
    }
    return {
      taskId,
      state: "running",
      runId,
      commander: true,
      commanderAgent,
      dispatchId,
      target: { kind: "supervised_worker", worktree: "new-child", agent: commanderAgent },
      warnings,
      nextAction: `poll with orca_get_task_status({ taskId: ${taskId}, run: ${runId} })`,
    };
  } catch (error) {
    warnings.push(`worker-start failed: ${failureLine(error)} — タスクは作成済み`);
    return {
      taskId,
      state: "queued",
      runId,
      commander: true,
      commanderAgent,
      dispatchId: null,
      target: { kind: "supervised_worker", worktree: "new-child", agent: commanderAgent },
      warnings,
      nextAction: `Commander が未起動。orca_get_task_status({ taskId: ${taskId}, run: ${runId} }) で確認`,
    };
  }
}

/**
 * worker 行にエージェント名が無いとき(context-only dispatch では projection.provider が null)
 * terminal list の agentIdentity から補強する。観測の強化なので失敗しても poll は壊さない。
 */
async function enrichAgentNames(client: OrcaClient, workers: JsonObject[]): Promise<void> {
  const missing = workers.filter(
    (worker) => worker["agent"] === null && typeof worker["terminalHandle"] === "string",
  );
  if (missing.length === 0) {
    return;
  }
  try {
    const listed = unwrapResult(await client.terminalList({ limit: 100 }));
    const terminals = Array.isArray(listed["terminals"]) ? listed["terminals"].filter(isJsonObject) : [];
    const byHandle = new Map<string, string>();
    for (const terminal of terminals) {
      const handle = pickString(terminal, ["handle", "terminalHandle", "terminal_handle"]);
      const agent = pickString(terminal, ["agentIdentity", "agentType", "agent"]);
      if (handle !== undefined && agent !== undefined) {
        byHandle.set(handle, agent);
      }
    }
    for (const worker of missing) {
      const agent = byHandle.get(worker["terminalHandle"] as string);
      if (agent !== undefined) {
        worker["agent"] = agent;
      }
    }
  } catch {
    // 補強は省略する(agent は null のまま)
  }
}

/** poll: 現在の state / phase / workers / children を正規化して返す(読み取りのみ)。 */
export async function getTaskStatus(client: OrcaClient, input: TaskStatusInput): Promise<JsonObject> {
  const list = await client.taskList({ run: input.run, brief: false });
  const task = findTaskById(list, input.taskId);
  const rawStatus = pickString(task, ["status", "state", "taskStatus"]);
  const state = mapTaskState(rawStatus);
  const runId = pickString(task, ["run_id", "runId"]) ?? input.run ?? null;

  // dispatch id は dispatch-show と task 行(dispatch_id)の両方から拾う
  const dispatchesPayload = await client.dispatchShow(input.taskId);
  const dispatchRows = extractDispatches(dispatchesPayload);
  const dispatchIds = new Set(
    dispatchRows
      .map((dispatch) => pickString(dispatch, DISPATCH_ID_KEYS))
      .filter((value): value is string => value !== undefined),
  );
  const taskDispatchId = pickString(task, TASK_DISPATCH_KEYS);
  if (taskDispatchId !== undefined) {
    dispatchIds.add(taskDispatchId);
  }

  const workersPayload = await client.workerList({ run: input.run ?? runId ?? undefined, limit: 100 });
  const allWorkers = extractWorkers(workersPayload).map(toWorkerRow);
  // 対象タスクに紐づく worker だけを見せる(taskId / dispatchId のどちらか一致)
  const workers = allWorkers.filter(
    (worker) =>
      worker["taskId"] === input.taskId ||
      (typeof worker["dispatchId"] === "string" && dispatchIds.has(worker["dispatchId"] as string)),
  );

  // Commander が `run-create` で sub-run を作ると、その配下は呼び出し元 Run の
  // task-list に 1 件も現れない(実測: childCount: 0)。handle 照合で拾って合算する。
  const handles = commanderHandles(task, workers);
  const subCapture = await captureSubRuns(client, {
    callerRunId: runId,
    handles,
    taskCreatedAt: task["created_at"] ?? task["createdAt"],
    enabled: input.includeSubRuns !== false && (dispatchIds.size > 0 || workers.length > 0),
  });

  const allChildTasks = [...findChildTasks(list, input.taskId), ...subCapture.childTasks];
  const childTasks = allChildTasks.slice(0, MAX_CHILDREN);
  const children = childTasks.map((child) => {
    const childId = pickString(child, ID_KEYS);
    const childRunId = typeof child["__runId"] === "string" ? (child["__runId"] as string) : null;
    const pool = childRunId !== null ? subCapture.workers : allWorkers;
    return toChildRow(child, pool.filter((worker) => worker["taskId"] === childId), childRunId);
  });
  const childWorkers = children.flatMap((child) => child["workers"] as JsonObject[]);

  // --task で絞らず Run 全体を読み、対象タスクと直接の子タスクのゲートだけを残す
  // (Commander の子タスクに付いたゲートも見せるため)
  const scopeIds = new Set<string>([input.taskId]);
  for (const child of childTasks) {
    const childId = pickString(child, ID_KEYS);
    if (childId !== undefined) {
      scopeIds.add(childId);
    }
  }
  const gatesPayload = await client.gateList({ run: input.run ?? runId ?? undefined });
  const callerRunName = input.run ?? runId ?? null;
  const gates = [
    ...extractGates(gatesPayload)
      .filter((gate) => {
        const gateTask = pickString(gate, ["task_id", "taskId"]);
        return gateTask === undefined || scopeIds.has(gateTask);
      })
      .map((gate) => toGateRow(gate, callerRunName)),
    ...subCapture.gates.map((gate) => toGateRow(gate, pickString(gate, ["__runId"]) ?? null)),
  ];

  await enrichAgentNames(client, [...workers, ...childWorkers]);

  const commander =
    workers.length > 0
      ? {
          agent: workers[0]?.["agent"] ?? null,
          status: workers[0]?.["status"] ?? null,
          dispatchId: workers[0]?.["dispatchId"] ?? null,
        }
      : null;

  const phase = estimatePhase(state, [...workers, ...childWorkers], gates);

  const warnings: string[] = [...subCapture.warnings];
  const blockedReasons = await collectBlockedReasons(
    client,
    { state, tasks: [task, ...childTasks], gates, workers: [...workers, ...childWorkers], rootTaskId: input.taskId },
    warnings,
  );
  const blockedKind = primaryBlockedKind(blockedReasons);

  // dsh 型の worker は launch token が記録されず dispatch が agent_readiness で死ぬが、
  // pane は注入された goal を完走し `task-update` で報告する(E2E 実測: failed → completed)。
  // state は偽装せず、「報告が後から届く可能性がある」だけを正直に載せる。
  const tokenlessFailedDispatch = dispatchRows.some(
    (dispatch) =>
      (pickString(dispatch, ["status", "state"]) ?? "") === "failed" &&
      pickString(dispatch, ["launch_token_hash", "launchTokenHash"]) === undefined,
  );
  const liveWorker = workers.some((row) => row["liveness"] === "alive" || row["status"] === "running");
  const workerReportPending = state === "failed" && tokenlessFailedDispatch && liveWorker;

  return {
    taskId: input.taskId,
    state,
    phase,
    rawStatus: rawStatus ?? null,
    runId,
    title: pickString(task, TITLE_KEYS) ?? null,
    specPreview: preview(task["spec"], 200),
    assigneeHandle: pickString(task, ["assignee_handle", "assigneeHandle"]) ?? null,
    commander,
    workers,
    childCount: allChildTasks.length,
    returnedChildCount: children.length,
    childrenTruncated: allChildTasks.length > children.length,
    children,
    subRuns: subCapture.subRuns,
    subRunsDiscovered: subCapture.subRuns.length,
    subRunScanComplete: subCapture.scanComplete,
    subRunsTruncated: subCapture.subRunsTruncated,
    subRunScanPageCount: subCapture.scanPageCount,
    subRunScanRunCount: subCapture.scanRunCount,
    subRunScanLimit: subCapture.scanLimit,
    subRunOwnershipComplete: subCapture.ownershipComplete,
    subRunWorkerScanComplete: subCapture.workerScanComplete,
    gates,
    blockedReasons,
    warnings,
    workerReportPending,
    // worker が「要 attention」なら、ゲート以外の人間側停止(エージェントの承認プロンプトなど)の
    // 可能性がある。E2E で `orca skills get …` の承認待ち Commander が running のまま止まった。
    attentionRequired:
      workers.some((row) => row["requiresAttention"] === true) ||
      blockedReasons.some((reason) => reason["kind"] === "agent_prompt"),
    attentionNotes: workers
      .filter((row) => row["requiresAttention"] === true)
      .map(
        (row) =>
          `worker ${row["dispatchId"] ?? "?"}: liveness=${row["liveness"] ?? "unknown"}, categories=${JSON.stringify(row["attentionCategories"] ?? [])} — 承認待ちなら terminal(read)で確認`,
      ),
    createdAt: task["created_at"] ?? task["createdAt"] ?? null,
    completedAt: task["completed_at"] ?? task["completedAt"] ?? null,
    nextAction: nextActionHint(state, phase, workers.length + childWorkers.length + dispatchIds.size, blockedKind),
    ...(workerReportPending
      ? {
          workerReportNote:
            "dispatch は launch token 無しで失敗していますが worker terminal は生存中です。worker は task-update で報告するため、この failed は一時的で completed が後から届くことがあります(実測)。poll を打ち切る前に数回待ってください",
        }
      : {}),
  };
}

/** worker-read の出力し尾部をテキストに落とす(実ペイロードは terminal.tail / transcript.tail)。 */
function extractOutputText(read: JsonObject): {
  text: string | null;
  source: string | null;
  terminalStatus: string | null;
  nextCursor: string | null;
} {
  const transcript = isJsonObject(read["transcript"]) ? (read["transcript"] as JsonObject) : undefined;
  const terminal = isJsonObject(read["terminal"]) ? (read["terminal"] as JsonObject) : undefined;
  const status = isJsonObject(read["status"]) ? (read["status"] as JsonObject) : undefined;
  const pane = transcript ?? terminal;
  const lines = pane?.["tail"] ?? pane?.["lines"] ?? read["lines"];

  let text: string | null = null;
  if (Array.isArray(lines)) {
    text = lines.filter((line): line is string => typeof line === "string").join("\n");
  } else if (typeof read["text"] === "string") {
    text = read["text"];
  } else if (typeof read["output"] === "string") {
    text = read["output"];
  }

  return {
    text,
    source: str(read["source"]) ?? null,
    terminalStatus:
      (terminal !== undefined ? str(terminal["status"]) : undefined) ??
      (status !== undefined ? str(status["terminal"]) : undefined) ??
      null,
    nextCursor:
      (terminal !== undefined ? str(terminal["nextCursor"]) : undefined) ?? str(read["cursor"]) ?? null,
  };
}

/** 介入: メッセージ送信(ワーカーへの指示・質問・エスカレーション)。 */
export interface SendMessageInput {
  subject: string;
  body?: string;
  to?: string;
  run?: string;
  type?: string;
  priority?: string;
  threadId?: string;
  taskId?: string;
  dispatchId?: string;
  outcome?: "succeeded" | "failed";
}

const MESSAGE_TYPES = [
  "status",
  "dispatch",
  "worker_done",
  "merge_ready",
  "escalation",
  "handoff",
  "decision_gate",
  "question",
  "heartbeat",
] as const;

export async function sendMessage(client: OrcaClient, input: SendMessageInput): Promise<JsonObject> {
  if (input.type === "worker_done" && input.outcome === undefined) {
    throw new JobError(
      "outcome_required",
      "type: worker_done には outcome(succeeded / failed)が必要です",
      { validTypes: MESSAGE_TYPES },
    );
  }
  if (input.outcome !== undefined && input.type !== "worker_done") {
    throw new JobError(
      "outcome_not_allowed",
      "outcome は type: worker_done でのみ使えます(他種別で付けると worker_done の payload が狂うため)",
      { type: input.type, outcome: input.outcome },
    );
  }
  if (input.type === "worker_done" && input.dispatchId === undefined) {
    // CLI 側が worker_done に dispatchId を要求する(無いと弾かれる)ので先に良い形で伝える
    throw new JobError(
      "dispatch_id_required",
      "type: worker_done には dispatchId が必要です(orca_get_task_status の workers[].dispatchId / commander.dispatchId)",
      { taskId: input.taskId },
    );
  }

  const sent = await runMutation(client, input.run, () =>
    client.send({
      subject: input.subject,
      to: input.to,
      body: input.body,
      type: input.type,
      // worker_done は --outcome が CLI 側で必須。ここで渡さないと outcome が消える。
      outcome: input.outcome,
      priority: input.priority,
      threadId: input.threadId,
      taskId: input.taskId,
      dispatchId: input.dispatchId,
      run: input.run,
    }),
  );
  const source = unwrapResult(sent);

  return {
    ok: true,
    messageId: pickIdDeep(source, ["messageId", "message_id", "id"]) ?? null,
    deliveryId: pickIdDeep(source, ["deliveryId", "delivery_id"]) ?? null,
    to: input.to ?? null,
    runId: input.run ?? null,
    type: input.type ?? null,
    outcome: input.outcome ?? null,
    subject: input.subject,
  };
}

/** 介入: タスクのキャンセル(CLI の手順どおり worker を fence してから task を failed にする)。 */
export interface CancelTaskInput {
  taskId: string;
  run?: string;
  reason?: string;
  mode?: "stop" | "abandon";
  /** 既定 true: 子孫タスクとその worker まで子から順に止める。 */
  cascade?: boolean;
  /** 既定 true: Commander が自作した sub-run の部分木も cascade 対象に含める。 */
  includeSubRuns?: boolean;
}

/** cascade で訪れるタスク数の上限。超過は部分 cancel を避けるため無変更で断る。 */
const MAX_CASCADE_TASKS = 12;
/** 1 タスクあたりの dispatch 数の上限。超過は preflight で無変更断りの理由になる。 */
const MAX_FENCE_PER_TASK = 3;

/**
 * 対象タスクの**子孫を子から順(post-order)**に並べる(テスト対象)。
 *
 * cancel は「この委譲ジョブをキャンセル」なので、Commander だけ止めて
 * 子 Worker を走らせたままにしない。task-list 1 回の `parent_id` から木を作る。
 */
export function collectDescendants(payload: JsonObject, rootTaskId: string): JsonObject[] {
  const tasks = extractTasks(unwrapResult(payload));
  const byParent = new Map<string, JsonObject[]>();
  for (const task of tasks) {
    const parent = pickString(task, ["parent_id", "parentId"]);
    if (parent === undefined) {
      continue;
    }
    const siblings = byParent.get(parent) ?? [];
    siblings.push(task);
    byParent.set(parent, siblings);
  }

  const root = tasks.find((row) => pickString(row, ID_KEYS) === rootTaskId);
  if (root === undefined) {
    return [];
  }

  const ordered: JsonObject[] = [];
  const seen = new Set<string>();
  const visit = (row: JsonObject): void => {
    const id = pickString(row, ID_KEYS);
    if (id === undefined || seen.has(id)) {
      return; // 循環防御
    }
    seen.add(id);
    for (const child of byParent.get(id) ?? []) {
      visit(child);
    }
    ordered.push(row);
  };
  visit(root);
  return ordered;
}

/** 1 タスクの dispatch id を dispatch-show と task 行の両方から集める。 */
async function dispatchIdsOf(client: OrcaClient, task: JsonObject, taskId: string): Promise<Set<string>> {
  const ids = new Set(
    extractDispatches(await client.dispatchShow(taskId))
      .map((dispatch) => pickString(dispatch, DISPATCH_ID_KEYS))
      .filter((value): value is string => value !== undefined),
  );
  const fromRow = pickString(task, TASK_DISPATCH_KEYS);
  if (fromRow !== undefined) {
    ids.add(fromRow);
  }
  return ids;
}

const TERMINAL_STATES: JobState[] = ["completed", "failed", "cancelled"];

export async function cancelTask(client: OrcaClient, input: CancelTaskInput): Promise<JsonObject> {
  const list = await client.taskList({ run: input.run, brief: false });
  const task = findTaskById(list, input.taskId);
  const rawStatus = pickString(task, ["status", "state", "taskStatus"]);
  const state = mapTaskState(rawStatus);
  const runId = pickString(task, ["run_id", "runId"]) ?? input.run ?? null;
  const mode = input.mode ?? "stop";
  const reason = input.reason ?? "cancelled";
  const cascade = input.cascade ?? true;

  // 完了・キャンセル済みのタスクには何もしない(冪等)
  if (TERMINAL_STATES.includes(state)) {
    return {
      taskId: input.taskId,
      state,
      cancelled: false,
      cascade,
      runId,
      warnings: [`タスクはすでに ${rawStatus} です。変更していません`],
    };
  }

  const descendants = cascade ? collectDescendants(list, input.taskId) : [task];

  // Commander が sub-run を作っている場合、task ツリーだけ追う cascade は
  // sub-run の worker を走りたままにする(実測: 呼び出し元 Run には子が見えない)。
  // handle 照合で拾った部分木を **sub-run 側が先**に並べる = 呼び出し元 Run の
  // Commander(root)より先に止める。post-order なので各部分木の中も子が先。
  // sub-run を含む cascade は「配下を全部止める」ことを約束する操作なので、
  // 探索の前提(worker-list / run-list / handle)が読めないときにそのまま進めると、
  // 見落とした worker を走りたまま `cancelled: true` で返す(review10 §2)。
  // 前提の読み取り失敗は warning として残すだけでなく、preflight で断る。
  let subCapture: SubRunCapture = EMPTY_CAPTURE;
  const discoveryFailures: string[] = [];
  if (cascade && input.includeSubRuns !== false) {
    const handles = commanderHandles(task, []);
    let callerWorkerRows: JsonObject[] = [];
    // review11 §4: 探索機能が無い / Run が特定できないときは「走れないので止まらない」ではなく
    // **安全側で断る**(worker 一覧を読めない状態で fullyStopped: true を返さない)。
    if (typeof client.workerList !== "function") {
      discoveryFailures.push("client が workerList を持たず worker 一覧を読めない");
    } else if (typeof runId !== "string" || runId.length === 0) {
      discoveryFailures.push("呼び出し元 Run が特定できず worker-list を読めない");
    } else {
      try {
        const scan = await scanWorkerRows(client, runId);
        callerWorkerRows = scan.rows;
        if (!scan.complete) {
          discoveryFailures.push(
            `呼び出し元 Run の worker-list を ${scan.pages} ページで打ち切りました(${SCAN_STOP_TEXT[scan.stopReason]})`,
          );
        }
      } catch (error) {
        discoveryFailures.push(`cancel の worker-list に失敗: ${failureLine(error)}`);
      }
      for (const row of callerWorkerRows.map(toWorkerRow)) {
        if (row["taskId"] === input.taskId && typeof row["terminalHandle"] === "string") {
          handles.push(row["terminalHandle"] as string);
        }
      }
    }
    if (handles.length === 0 && callerWorkerRows.length > 0) {
      discoveryFailures.push("worker がいるのに Commander の terminal handle が取得できない(sub-run を照合できない)");
    }
    if (handles.length > 0 && typeof client.runList !== "function") {
      discoveryFailures.push("client が runList を持たず sub-run を探索できない(「sub-run は無い」とは言えない)");
    }
    const capture = await captureSubRuns(client, {
      callerRunId: runId,
      handles,
      taskCreatedAt: task["created_at"] ?? task["createdAt"],
      enabled: true,
    });
    subCapture = {
      ...capture,
      warnings: [...capture.warnings, ...discoveryFailures.map((line) => `cancel 前提の読み取りに失敗: ${line}`)],
    };
    if (subCapture.scanFailed) {
      discoveryFailures.push("sub-run 探索の run-list が読めない");
    }
    if (discoveryFailures.length > 0) {
      throw new JobError(
        "cancel_discovery_incomplete",
        `cascade cancel の前提となる探索(worker-list / run-list / handle)が揃わないため、何も変更していません(sub-run を見落とすと「全部止めた」の誤報になります)。${discoveryFailures.join(" / ")}。sub-run を巻き込まずに止めるなら includeSubRuns: false(または cascade: false)`,
        {
          taskId: input.taskId,
          runId,
          discoveryFailures,
          subRunsDiscovered: capture.subRuns.length,
          subRunScanComplete: capture.scanComplete,
        },
      );
    }
  }

  // P4 / P5(review9 §6): 所有検証に失敗した sub-run は auto-cancel の対象にしない。
  // verified は coordinator_handle + pane key / incarnation まで一致した Run だけ。
  // probable(来歴の確認が取れない)/ unverified / conflicting を叩くと、
  // 別 job・別 terminal の worker を止める事故になる。
  const eligibleRunIds = new Set(
    subCapture.subRuns
      .filter((row) => row["cancelEligible"] === true && typeof row["runId"] === "string")
      .map((row) => row["runId"] as string),
  );
  const unverifiedRuns = subCapture.subRuns.filter((row) => row["cancelEligible"] !== true);
  if (unverifiedRuns.length > 0) {
    throw new JobError(
      "cancel_ownership_unverified",
      `sub-run ${unverifiedRuns.length} 件の所有関係が verified ではないため、何も変更していません(auto-cancel は verified のみ)。subRuns[].ownership / verificationReasons を確認してください。sub-run を含めずに止めるなら includeSubRuns: false(または cascade: false)、sub-run 側は Run を名指しで個別にキャンセルしてください`,
      {
        taskId: input.taskId,
        runId,
        subRuns: subCapture.subRuns.map((row) => ({
          runId: row["runId"] ?? null,
          ownership: row["ownership"] ?? null,
          cancelEligible: row["cancelEligible"] ?? false,
          verificationReasons: row["verificationReasons"] ?? [],
        })),
      },
    );
  }
  const subRunTargets = subCapture.subtreeTasks.filter(
    (row) => typeof row["__runId"] !== "string" || eligibleRunIds.has(row["__runId"]),
  );

  const targets = [...subRunTargets, ...descendants];

  // 上限超過は**何も変更する前に**断る。collectDescendants は post-order なので、
  // 子孫を 12 件で切ると末尾の root(Commander)だけが対象から漏れ、
  // 「一部しか止めていないのに cancelled: true」になり得る。部分 cancel を黙って
  // 返すより、cascade: false か個別 cancel を選んでもらう方が安全。
  if (targets.length > MAX_CASCADE_TASKS) {
    throw new JobError(
      "cancel_scope_too_large",
      `cascade 対象が ${targets.length} 件あり、上限 ${MAX_CASCADE_TASKS} 件を超えます(sub-run 含む)。何も変更していません。cascade: false で対象タスクだけ止めるか、子タスクを個別にキャンセルしてください`,
      {
        taskId: input.taskId,
        runId,
        taskCount: targets.length,
        maxCascadeTasks: MAX_CASCADE_TASKS,
        subRunsDiscovered: subCapture.subRuns.length,
        sampleTaskIds: targets.slice(0, 5).map((row) => pickString(row, ID_KEYS) ?? null),
      },
    );
  }
  const warnings: string[] = [...subCapture.warnings];

  // Phase 1: preflight — 全 target の dispatch を**変更前に**読み切って上限を点検する。
  // 処理しながら検査すると「子 A は cancel 済み、子 B で dispatch 5 件を発見 → error」
  // という部分 cancel になる。silent slice で黙って切っても同じ事故(dispatch D を
  // 生かしたまま task だけ failed にし、cancelled: true を返す)になるので、ここで断る。
  const dispatchesByTarget = new Map<string, string[]>();
  for (const target of targets) {
    const targetId = pickString(target, ID_KEYS) ?? input.taskId;
    const targetState = mapTaskState(pickString(target, ["status", "state", "taskStatus"]));
    if (TERMINAL_STATES.includes(targetState)) {
      continue; // 終端の子は触らない
    }
    const dispatchIds = [...(await dispatchIdsOf(client, target, targetId))];
    if (dispatchIds.length > MAX_FENCE_PER_TASK) {
      throw new JobError(
        "cancel_dispatch_scope_too_large",
        `task ${targetId} に ${dispatchIds.length} dispatch があり、上限 ${MAX_FENCE_PER_TASK} を超えています。何も変更していません。個別に worker-stop してから再試行してください`,
        {
          taskId: targetId,
          runId,
          dispatchCount: dispatchIds.length,
          maxDispatchesPerTask: MAX_FENCE_PER_TASK,
          dispatchIds: dispatchIds.slice(0, 6),
        },
      );
    }
    dispatchesByTarget.set(targetId, dispatchIds);
  }

  const workers: JsonObject[] = [];
  const tasks: JsonObject[] = [];
  let fenceFailures = 0;
  // 同一 dispatch を 2 回叩かない(sub-run 集約と task ツリーが同じ dispatch を重ねて持つことがある)。
  const fencedDispatchIds = new Set<string>();

  // Phase 2: mutation — 子から順に「worker を fence → task を failed/cancelled」(CLI の手順)
  for (const target of targets) {
    const targetId = pickString(target, ID_KEYS) ?? input.taskId;
    const dispatchIds = (dispatchesByTarget.get(targetId) ?? []).filter((dispatchId) => !fencedDispatchIds.has(dispatchId));
    if (dispatchesByTarget.get(targetId) === undefined) {
      continue; // preflight で終端と判定した target
    }

    const fenced: JsonObject[] = [];
    const failedDispatches: string[] = [];
    for (const dispatchId of dispatchIds) {
      fencedDispatchIds.add(dispatchId);
      try {
        const fencedResult = unwrapResult(
          mode === "abandon" ? await client.workerAbandon(dispatchId) : await client.workerStop(dispatchId),
        );
        fenced.push({
          dispatchId,
          taskId: targetId,
          action: mode,
          resultState: pickString(fencedResult, ["state", "workerState", "status"]) ?? null,
          processAction: pickString(fencedResult, ["processAction", "process_action"]) ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fenced.push({ dispatchId, taskId: targetId, action: mode, error: message });
        failedDispatches.push(dispatchId);
        fenceFailures += 1;
        warnings.push(`dispatch ${dispatchId} の ${mode} に失敗: ${message}`);
      }
    }
    workers.push(...fenced);

    // 対象(Commander)の worker が止められた保証が無いなら、task だけ failed にして
    // cancelled: true を返さない = 「論理 cancel」と「実プロセス停止」のズレを放置しない。
    // Commander はこれ以上 orchestration を進める主体なので、走りたままの cancel 宣言は危険。
    if (targetId === input.taskId && failedDispatches.length > 0) {
      throw new JobError(
        "cancel_incomplete",
        "Commander worker の停止に失敗したため、ジョブを完全にキャンセルできませんでした。対象 task は更新していません。",
        {
          taskId: targetId,
          runId,
          state: "partial",
          cancelled: false,
          fullyStopped: false,
          failedDispatches,
          cancelledTasks: tasks,
          fencedWorkers: workers,
        },
      );
    }

    // sub-run 側のタスクは sub-run 名義で叩く(task-update の Run スコープは
    // バインドで決まるので、runMutation が consumer_fenced 時にその run へ切り替える)。
    const targetRun = typeof target["__runId"] === "string" ? (target["__runId"] as string) : (runId ?? undefined);
    try {
      await runMutation(client, targetRun, () =>
        client.taskUpdate({
          id: targetId,
          status: "failed",
          result: `cancelled: ${reason}`,
          run: targetRun,
        }),
      );
      tasks.push({ taskId: targetId, state: "cancelled", fenced, runId: targetRun ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const boundRun = error instanceof OrcaCommandError ? extractBoundRun(error.message) : undefined;
      if (targetId === input.taskId) {
        // 対象(Commander)の確定だけ失敗した = ジョブはキャンセルしきれない
        throw new JobError(
          "cancel_incomplete",
          `worker は fence しましたが task のキャンセル確定に失敗しました: ${message}`,
          {
            taskId: input.taskId,
            runId,
            state: "partial",
            cancelled: false,
            fullyStopped: fenceFailures === 0,
            fencedWorkers: workers,
            cancelledTasks: tasks,
            boundRun,
          },
        );
      }
      warnings.push(`子タスク ${targetId} のキャンセル確定に失敗: ${message}`);
      tasks.push({ taskId: targetId, state: "incomplete", fenced, error: message });
    }
  }

  // P5(review9 §6): 停止後に worker を読み直し、残っている worker を正直に出す。
  // 探索を打ち切った(scanComplete: false / subRunsTruncated)場合は「全部止めた」と宣言しない。
  const cancelledTaskIds = new Set(tasks.map((row) => row["taskId"]).filter((id): id is string => typeof id === "string"));
  const residualRuns = [runId, ...eligibleRunIds];
  // 読み直せる Run が 1 つも無い = 残存 worker を検証できない(review11 §4 の安全側)。
  const residualUnverifiable = !residualRuns.some((run) => typeof run === "string" && run.length > 0);
  const scanIncomplete =
    !subCapture.scanComplete || subCapture.subRunsTruncated || !subCapture.workerScanComplete || residualUnverifiable;
  const residual = await residualLiveWorkers(client, residualRuns, cancelledTaskIds);
  if (scanIncomplete) {
    warnings.push(
      residualUnverifiable
        ? "停止後に worker-list を読み直せる Run が特定できないため、stop の完了を保証できません(fullyStopped: false)"
        : "探索を打ち切ったため、stop の完了を保証できません(fullyStopped: false)",
    );
  }
  if (residual.length > 0) {
    warnings.push(`停止後に読み直したところ ${residual.length} 個の worker が生存しています(pane を確認してください)`);
  }

  return {
    taskId: input.taskId,
    state: "cancelled",
    cancelled: true,
    // fence 失敗 / 探索の打ち切り / 停止後も残った worker が 1 つでもあれば fullyStopped: false
    fullyStopped: fenceFailures === 0 && !scanIncomplete && residual.length === 0,
    cascade,
    taskCount: tasks.length,
    runId,
    subRunsDiscovered: subCapture.subRuns.length,
    subRuns: subCapture.subRuns,
    subRunScanComplete: subCapture.scanComplete,
    subRunsTruncated: subCapture.subRunsTruncated,
    subRunOwnershipComplete: subCapture.ownershipComplete,
    subRunWorkerScanComplete: subCapture.workerScanComplete,
    residualWorkers: residual,
    mode,
    reason,
    tasks,
    workers,
    warnings,
    note: cascade
      ? "CLI のキャンセル手順を子から順に適用しました(worker fence → task failed/cancelled)"
      : "CLI のキャンセル手順を対象タスクにだけ適用しました(cascade: false)",
  };
}

/** 停止後に読み直して、まだ走っている worker を返す(P5: fullyStopped の根拠を実データにする)。 */
async function residualLiveWorkers(
  client: OrcaClient,
  runs: Array<string | null>,
  taskIds: Set<string>,
): Promise<JsonObject[]> {
  const LIVE = new Set(["running", "blocked", "queued", "unknown"]);
  const residual: JsonObject[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    if (typeof run !== "string" || run.length === 0 || seen.has(run)) {
      continue;
    }
    seen.add(run);
    try {
      const scan = await scanWorkerRows(client, run);
      if (!scan.complete) {
        // 打ち切り = 残存 worker を検証できない。「読めない」と同じ扱いで正直に残す
        residual.push({
          taskId: null,
          dispatchId: null,
          runId: run,
          status: "scan_incomplete",
          error: `${scan.pages} ページで打ち切り(${SCAN_STOP_TEXT[scan.stopReason]})`,
        });
      }
      for (const row of scan.rows.map(toWorkerRow)) {
        const taskId = row["taskId"];
        const status = row["status"];
        if (typeof taskId !== "string" || !taskIds.has(taskId)) {
          continue;
        }
        if (typeof status === "string" && LIVE.has(status)) {
          residual.push({ taskId, dispatchId: row["dispatchId"] ?? null, runId: run, status });
        }
      }
    } catch (error) {
      // 読み直せない = 検証できないので、呼び出し側が判断できる形で残す
      residual.push({ taskId: null, dispatchId: null, runId: run, status: "unreadable", error: failureLine(error) });
    }
  }
  return residual;
}

/**
 * 介入: 判断ゲートを承認/却下して Commander を進める(Human-in-the-loop)。
 *
 * gate は Run バインドスコープ(gate-resolve に --run は無い)なので、
 * consumer_fenced になったときだけ runMutation が run-use で切り替えて 1 回再試行する。
 * 解決済みゲートには何もしない(冪等)。
 */
export interface ResolveGateInput {
  gateId: string;
  resolution: string;
  run: string;
  /**
   * 解決してよいゲートが**この job(親 task)のものか**を点検するための任意指定(review10 §3)。
   * 指定したゲート task がこの task そのもの、またはその部分木に属さない場合は
   * `gate_task_mismatch` で**何も変更する前に**拒否する。
   */
  taskId?: string;
}

export async function resolveGate(client: OrcaClient, input: ResolveGateInput): Promise<JsonObject> {
  const listed = unwrapResult(await client.gateList({ run: input.run }));
  const gates = extractGates(listed);
  const gate = gates.find((row) => pickString(row, ["gateId", "gate_id", "id"]) === input.gateId);
  if (gate === undefined) {
    throw new JobError(
      "gate_not_found",
      `ゲート ${input.gateId} が Run ${input.run} に見つかりません`,
      { gateId: input.gateId, run: input.run, gateCount: gates.length },
    );
  }

  const gateRunId = pickString(gate, ["run_id", "runId"]) ?? input.run;
  const taskId = pickString(gate, ["task_id", "taskId"]) ?? null;
  const status = pickString(gate, ["status", "state"]);

  // **変更前に** gateId と run の組を点検する。gate-list は `--run` で名指しした Run を
  // 読むが、行の `run_id` が指定 Run と違うなら「指定 Run のゲート」という前提が崩れる。
  // gate-resolve には `--run` が無いので、このまま叩くと別 Run のゲートを解決する
  // (runMutation が gate 側の Run へ binding を切り替えてしまう)。
  if (gateRunId !== input.run) {
    throw new JobError(
      "gate_run_mismatch",
      `ゲート ${input.gateId} の所属 Run は ${gateRunId} です(指定 ${input.run} と一致しません)。何も変更していません。poll の gates[].runId を run に渡してください`,
      { gateId: input.gateId, requestedRun: input.run, gateRunId, taskId },
    );
  }

  const runId = gateRunId;

  // 認可の境界(review10 §3): gate-resolve は「Run ID と Gate ID を知る誰でも」解決できる CLI 構造。
  // MCP 側は単一ユーザー / 信頼できるクライアント前提で認可を持たないので、呼び出し側が
  // 「自分の job のゲートか」を点検できる口を任意で持つ。指定された task と無関係なゲートを
  // 解決しないための gate で、部分木(この task が分解した子孫)は許可する。
  const gateTaskId = pickString(gate, ["task_id", "taskId"]) ?? null;
  if (input.taskId !== undefined && gateTaskId !== input.taskId) {
    const related = new Set<string>([input.taskId]);
    const listed = await client.taskList({ run: input.run, brief: false });
    for (const row of collectDescendants(listed, input.taskId)) {
      const id = pickString(row, ID_KEYS);
      if (id !== undefined) {
        related.add(id);
      }
    }
    if (gateTaskId === null || !related.has(gateTaskId)) {
      throw new JobError(
        "gate_task_mismatch",
        `ゲート ${input.gateId} の task は ${gateTaskId ?? "無し"} で、指定した task ${input.taskId}(とその部分木)に属しません。何も変更していません。taskId の指定を外すか、poll の gates[].taskId を渡してください`,
        { gateId: input.gateId, gateTaskId, requestedTaskId: input.taskId, run: input.run },
      );
    }
  }

  // 解決済みゲートには触らない(冪等)。CLI は解決の取り消しを支持していない。
  if (status !== undefined && status.toLowerCase() !== "pending") {
    return {
      gateId: input.gateId,
      resolved: false,
      status,
      taskId,
      runId,
      warnings: [`ゲートはすでに ${status} です。変更していません`],
    };
  }

  const resolved = unwrapResult(
    await runMutation(client, runId, () =>
      client.gateResolve({ id: input.gateId, resolution: input.resolution }),
    ),
  );
  const gateRow = isJsonObject(resolved["gate"]) ? (resolved["gate"] as JsonObject) : resolved;

  return {
    gateId: pickString(gateRow, ["gateId", "gate_id", "id"]) ?? input.gateId,
    resolved: true,
    status: pickString(gateRow, ["status", "state"]) ?? "resolved",
    resolution: pickString(gateRow, ["resolution"]) ?? input.resolution,
    taskId,
    runId,
    resolvedAt: gateRow["resolved_at"] ?? gateRow["resolvedAt"] ?? null,
    warnings: [],
    note: "gate-resolve を実行しました。Commander はこの結論を受けて進みます",
  };
}

/** includeChildren で読む子タスク数の上限。 */
const MAX_CHILD_RESULTS = 10;
/** includeChildren で読む worker-read の総数上限(応答サイズと CLI 呼び出し数の抑制)。 */
const MAX_CHILD_OUTPUTS = 8;

/** 子タスクの dispatch id(行に `dispatch_id` があれば dispatch-show は読まない)。 */
async function childDispatchIds(
  client: OrcaClient,
  child: JsonObject,
  childId: string,
): Promise<Set<string>> {
  const fromRow = pickString(child, TASK_DISPATCH_KEYS);
  if (fromRow !== undefined) {
    return new Set([fromRow]);
  }
  return dispatchIdsOf(client, child, childId);
}

/** result: 完了時の result と worker 出力を読む(読み取りのみ)。子を含めるかは includeChildren。 */
export async function getTaskResult(client: OrcaClient, input: TaskResultInput): Promise<JsonObject> {
  const list = await client.taskList({ run: input.run, brief: false });
  const task = findTaskById(list, input.taskId);
  const rawStatus = pickString(task, ["status", "state", "taskStatus"]);
  const state = mapTaskState(rawStatus);
  const runId = pickString(task, ["run_id", "runId"]) ?? input.run ?? null;

  const dispatchIds = await dispatchIdsOf(client, task, input.taskId);

  const limit = input.outputLimit ?? 40;
  const outputs: JsonObject[] = [];
  for (const dispatchId of [...dispatchIds].slice(0, 3)) {
    try {
      const read = unwrapResult(await client.workerRead({ dispatch: dispatchId, limit }));
      const extracted = extractOutputText(read);
      outputs.push({
        dispatchId,
        agent: pickString(read, AGENT_KEYS) ?? null,
        source: extracted.source,
        terminalStatus: extracted.terminalStatus,
        text: preview(extracted.text, 4000),
        cursor: read["cursor"] ?? null,
        nextCursor: extracted.nextCursor,
      });
    } catch (error) {
      outputs.push({
        dispatchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 子タスクの成果は頼まれたときだけ集約する(既定は Commander だけ = 応答が膨らみすぎない)
  const children: JsonObject[] = [];
  let childrenTruncated = false;
  let subCapture: SubRunCapture = EMPTY_CAPTURE;
  if (input.includeChildren === true) {
    // Commander が sub-run を作っていると、その子タスクは呼び出し元 Run の
    // task-list に無いので result からも消える(実測: 結果回収が壊れる)。拾って合算する。
    subCapture = await captureSubRuns(client, {
      callerRunId: runId,
      handles: commanderHandles(task, []),
      taskCreatedAt: task["created_at"] ?? task["createdAt"],
      enabled: input.includeSubRuns !== false,
    });
    const subDispatchByTask = new Map<string, string[]>();
    for (const worker of subCapture.workers) {
      const taskId = worker["taskId"];
      const dispatchId = worker["dispatchId"];
      if (typeof taskId === "string" && typeof dispatchId === "string") {
        const bucket = subDispatchByTask.get(taskId) ?? [];
        bucket.push(dispatchId);
        subDispatchByTask.set(taskId, bucket);
      }
    }

    const childTasks = [...findChildTasks(list, input.taskId), ...subCapture.childTasks];
    const targets = childTasks.slice(0, MAX_CHILD_RESULTS);
    childrenTruncated = childTasks.length > targets.length;
    let reads = 0;

    for (const child of targets) {
      const childId = pickString(child, ID_KEYS);
      if (childId === undefined) {
        continue;
      }
      const childOutputs: JsonObject[] = [];
      if (reads < MAX_CHILD_OUTPUTS) {
        // sub-run の子行には dispatch_id が無いので、capture 済みの worker 行から拾う
        // (dispatch-show を sub-run 名義で足しにいかない)
        const fromSub = subDispatchByTask.get(childId);
        const ids = fromSub !== undefined && fromSub.length > 0
          ? fromSub
          : [...(await childDispatchIds(client, child, childId))];
        for (const dispatchId of ids.slice(0, 1)) {
          reads += 1;
          try {
            const read = unwrapResult(await client.workerRead({ dispatch: dispatchId, limit }));
            const extracted = extractOutputText(read);
            childOutputs.push({
              dispatchId,
              agent: pickString(read, AGENT_KEYS) ?? null,
              source: extracted.source,
              text: preview(extracted.text, 2000),
            });
          } catch (error) {
            childOutputs.push({
              dispatchId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      children.push({
        taskId: childId,
        title: pickString(child, TITLE_KEYS) ?? null,
        state: mapTaskState(pickString(child, ["status", "state", "taskStatus"])),
        result: child["result"] ?? null,
        resultPreview: preview(child["result"], 500),
        sourceRunId: child["__runId"] ?? null,
        outputs: childOutputs,
      });
    }
  }

  return {
    taskId: input.taskId,
    state,
    rawStatus: rawStatus ?? null,
    runId,
    result: task["result"] ?? null,
    resultPreview: preview(task["result"], 2000),
    outputs,
    includeChildren: input.includeChildren === true,
    children,
    childrenTruncated,
    subRunsDiscovered: subCapture.subRuns.length,
    subRuns: subCapture.subRuns,
    subRunScanComplete: subCapture.scanComplete,
    subRunsTruncated: subCapture.subRunsTruncated,
    subRunOwnershipComplete: subCapture.ownershipComplete,
    subRunWorkerScanComplete: subCapture.workerScanComplete,
    warnings: subCapture.warnings,
    createdAt: task["created_at"] ?? task["createdAt"] ?? null,
    finishedAt: task["completed_at"] ?? task["completedAt"] ?? null,
  };
}
