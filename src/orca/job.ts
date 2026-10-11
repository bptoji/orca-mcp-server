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
      const fenced =
        error instanceof OrcaCommandError &&
        (error.code === "consumer_fenced" || error.message.includes("consumer_fenced"));
      if (!fenced || runId === undefined) {
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
  gate: "判断ゲートが pending。blockedReasons の question / options を確認し、承認/却下は orca_resolve_gate({ gateId, resolution, run })",
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
      detail: { gateId: gate["id"] ?? null, options: gate["options"] ?? null },
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
          const read = unwrapResult(await client.workerRead({ dispatch: dispatchId, limit: ATTENTION_READ_LINES }));
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
          outputTail: output,
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
        ? "判断ゲートが pending(gates を参照)。承認/却下は orca_resolve_gate({ gateId, resolution, run })"
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
export function toChildRow(child: JsonObject, workers: JsonObject[]): JsonObject {
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
the gate on your own task and resolve it when the human answers.

Run ownership:
You are already dispatched inside a Run and a task. Do not create new Runs.
Create child tasks with --parent set to your task, inside your own Run, and
delegate them to supervised workers. A new Run fragments the job the caller is
polling and cancels.

Completion boundary:
Before declaring success, verify that every delegated child task has reached a
terminal state and inspect its result. Do not report completion while any child
task is still running, blocked, failed, or unaccounted for.

Do not mark the parent task successful if any required child task failed.
Resolve, retry, replace, or explicitly report the failure first.

Every subtask spec you create must be self-contained and name the target, the
change, the constraints, the ownership boundary, and the observable acceptance.`;

const DEFAULT_CONSTRAINTS = ["Preserve existing APIs and project conventions."];

function commanderSpec(input: DelegateTaskInput): string {
  const constraints =
    input.constraints !== undefined && input.constraints.length > 0
      ? input.constraints.map((line) => `- ${line}`).join("\n")
      : DEFAULT_CONSTRAINTS.map((line) => `- ${line}`).join("\n");

  return COMMANDER_PROMPT
    .replace("{{goal}}", input.spec)
    .replace("{{repo}}", input.repo ?? "the current repository")
    .replace("{{constraints}}", constraints);
}

export interface TaskStatusInput {
  taskId: string;
  run?: string;
}

export interface TaskResultInput {
  taskId: string;
  run?: string;
  outputLimit?: number;
  /** 既定 false: Commander だけ読む。true にすると子タスクの成果と出力も集約する。 */
  includeChildren?: boolean;
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
  const task = await runMutation(client, runId, () =>
    client.taskCreate({
      spec: commanderSpec(input),
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

  const allChildTasks = findChildTasks(list, input.taskId);
  const childTasks = allChildTasks.slice(0, MAX_CHILDREN);
  const children = childTasks.map((child) =>
    toChildRow(child, allWorkers.filter((worker) => worker["taskId"] === pickString(child, ID_KEYS))),
  );
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
  const gates = extractGates(gatesPayload)
    .filter((gate) => {
      const gateTask = pickString(gate, ["task_id", "taskId"]);
      return gateTask === undefined || scopeIds.has(gateTask);
    })
    .map((gate) => ({
      id: pickString(gate, ["gateId", "gate_id", "id"]) ?? null,
      taskId: pickString(gate, ["task_id", "taskId"]) ?? null,
      status: pickString(gate, ["status", "state"]) ?? null,
      question: preview(gate["question"], MAX_REASON_TEXT),
      options: gate["options"] ?? null,
    }));

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

  const warnings: string[] = [];
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

  // 上限超過は**何も変更する前に**断る。collectDescendants は post-order なので、
  // 子孫を 12 件で切ると末尾の root(Commander)だけが対象から漏れ、
  // 「一部しか止めていないのに cancelled: true」になり得る。部分 cancel を黙って
  // 返すより、cascade: false か個別 cancel を選んでもらう方が安全。
  if (descendants.length > MAX_CASCADE_TASKS) {
    throw new JobError(
      "cancel_scope_too_large",
      `cascade 対象が ${descendants.length} 件あり、上限 ${MAX_CASCADE_TASKS} 件を超えます。何も変更していません。cascade: false で対象タスクだけ止めるか、子タスクを個別にキャンセルしてください`,
      {
        taskId: input.taskId,
        runId,
        taskCount: descendants.length,
        maxCascadeTasks: MAX_CASCADE_TASKS,
        sampleTaskIds: descendants.slice(0, 5).map((row) => pickString(row, ID_KEYS) ?? null),
      },
    );
  }

  const targets = descendants;
  const warnings: string[] = [];

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

  // Phase 2: mutation — 子から順に「worker を fence → task を failed/cancelled」(CLI の手順)
  for (const target of targets) {
    const targetId = pickString(target, ID_KEYS) ?? input.taskId;
    const dispatchIds = dispatchesByTarget.get(targetId);
    if (dispatchIds === undefined) {
      continue; // preflight で終端と判定した target
    }

    const fenced: JsonObject[] = [];
    const failedDispatches: string[] = [];
    for (const dispatchId of dispatchIds) {
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

    try {
      await runMutation(client, runId ?? undefined, () =>
        client.taskUpdate({
          id: targetId,
          status: "failed",
          result: `cancelled: ${reason}`,
          run: runId ?? undefined,
        }),
      );
      tasks.push({ taskId: targetId, state: "cancelled", fenced });
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

  return {
    taskId: input.taskId,
    state: "cancelled",
    cancelled: true,
    // fence に 1 件でも失敗があれば fullyStopped: false(実プロセス停止の保証なし)
    fullyStopped: fenceFailures === 0,
    cascade,
    taskCount: tasks.length,
    runId,
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

  const runId = pickString(gate, ["run_id", "runId"]) ?? input.run;
  const taskId = pickString(gate, ["task_id", "taskId"]) ?? null;
  const status = pickString(gate, ["status", "state"]);

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
  if (input.includeChildren === true) {
    const childTasks = findChildTasks(list, input.taskId);
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
        for (const dispatchId of [...(await childDispatchIds(client, child, childId))].slice(0, 1)) {
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
    createdAt: task["created_at"] ?? task["createdAt"] ?? null,
    finishedAt: task["completed_at"] ?? task["completedAt"] ?? null,
  };
}
