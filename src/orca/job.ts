import {
  extractTasks,
  type JsonObject,
  type OrcaClient,
} from "./client.js";

/**
 * 非同期 Job API の内部モデル。
 *
 * 原則: MCP の 1 呼び出しを長時間ブロックしない。
 *  - submit(orca_delegate_task) … task-create + dispatch までを素早く済ませ、
 *    `{ taskId, state: "running" }` を返して即座に応答する。
 *  - poll(orca_get_task_status) … 現在の state / phase / workers を返す。
 *  - result(orca_get_task_result) … 完了時の result と worker 出力のし尾部を返す。
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

const ID_KEYS = ["taskId", "task_id", "id"] as const;
const DISPATCH_ID_KEYS = ["dispatchId", "dispatch_id", "id"] as const;
const AGENT_KEYS = ["agent", "agentType", "agentId", "agentIdentity", "agent_type"] as const;

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

/** worker の生の状態 → 正規化 status。 */
export function mapWorkerStatus(raw: string | undefined): string {
  switch (raw?.toLowerCase()) {
    case "succeeded":
    case "completed":
    case "done":
      return "completed";
    case "failed":
    case "errored":
      return "failed";
    case "running":
    case "active":
    case "working":
      return "running";
    case "unsupervised":
      // `dispatch` が採用したターミナルでエージェントが動いている状態
      return "running";
    case "released":
    case "retained":
    case "reclaimable":
      return "settled";
    case "pending":
    case "queued":
      return "queued";
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

/** worker を Job API 用の 1 行に正規化する(テスト対象)。 */
export function toWorkerRow(worker: JsonObject): JsonObject {
  const dispatchId = pickString(worker, DISPATCH_ID_KEYS) ?? null;
  const rawStatus = pickString(worker, ["status", "workerStatus", "state", "worker_state"]);
  const terminalState = pickString(worker, ["terminalState", "terminal_state", "resourceState"]);
  const row: JsonObject = {
    agent: pickString(worker, AGENT_KEYS) ?? null,
    status: mapWorkerStatus(rawStatus),
    rawStatus: rawStatus ?? null,
    dispatchId,
    terminalState: terminalState ?? null,
    worktreeId: pickString(worker, ["worktreeId", "worktree_id"]) ?? null,
    terminalHandle: pickString(worker, ["terminalHandle", "terminal_handle", "handle"]) ?? null,
  };
  const updatedAt = worker["updatedAt"] ?? worker["lastOutputAt"];
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
  if (state === "blocked" || pendingGates.length > 0) {
    return "decision_gate";
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

/** state に応じた次のアクション(呼び出し側が迷わないための手掛かり)。 */
export function nextActionHint(state: JobState, phase: JobPhase): string {
  switch (state) {
    case "queued":
      return "poll again; dispatch が未完了なら orca_get_task_status を再試行";
    case "running":
      return "poll again with orca_get_task_status";
    case "blocked":
      return phase === "decision_gate"
        ? "判断が必要(gate-list を参照)。MCP 側では介入しない"
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

/** worktree 名を組み立てる(英数字に落とし、末尾に短 ID を足す)。 */
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
  agent?: string;
  worktree?: string;
  terminal?: string;
  repo?: string;
  run?: string;
  deps?: string[];
  parent?: string;
  prompt?: string;
}

export interface TaskStatusInput {
  taskId: string;
  run?: string;
}

export interface TaskResultInput {
  taskId: string;
  run?: string;
  outputLimit?: number;
}

function runIdOf(payload: JsonObject): string | undefined {
  return pickIdDeep(unwrapResult(payload), ["runId", "run_id", "id"]);
}

/**
 * submit: task-create までを確実に済ませ、可能なら dispatch して `{ taskId, state }` を返す。
 * dispatch に失敗してもタスクは存在するので state: "queued" + warnings で返す(例外にしない)。
 */
export async function delegateTask(
  client: OrcaClient,
  input: DelegateTaskInput,
): Promise<JsonObject> {
  const warnings: string[] = [];

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

  // 2) task-create(ここが成功すれば Job は成立する)
  const task = await client.taskCreate({
    spec: input.spec,
    title: input.title,
    deps: input.deps,
    parent: input.parent,
    run: runId,
  });
  const taskId = pickIdDeep(unwrapResult(task), ID_KEYS);
  if (taskId === undefined) {
    throw new JobError("task_id_missing", "task-create の応答からタスク ID を取得できませんでした", task);
  }

  // 3) dispatch 先を決める(terminal > worktree > 新規 worktree + agent)
  let handle: string | undefined = input.terminal;
  let kind: "terminal" | "worktree" | "new_worktree" = "terminal";
  let worktreeSelector: string | undefined = input.worktree;
  const agent = input.agent ?? "codex";

  if (handle === undefined) {
    if (worktreeSelector !== undefined) {
      kind = "worktree";
      handle = await firstTerminalHandle(client, worktreeSelector);
    } else {
      kind = "new_worktree";
      const name = buildWorktreeName(input.title, input.spec);
      const created = await client.worktreeCreate({
        name,
        repo: input.repo,
        agent,
        prompt: input.prompt ?? input.spec,
      });
      const createdResult = unwrapResult(created);
      worktreeSelector =
        pickString(createdResult, ["worktreeId", "worktree_id", "path", "name"]) ??
        pickString(unwrapResult(pickObject(createdResult["worktree"])), ["worktreeId", "id", "path"]) ??
        name;
      handle =
        pickString(createdResult, ["agentTerminalHandle", "agent_terminal_handle"]) ??
        pickString(pickObject(createdResult["startupTerminal"]), ["handle"]) ??
        (await firstTerminalHandle(client, worktreeSelector));
    }
  }

  // 4) dispatch(失敗しても Job は生かす)
  let dispatchId: string | null = null;
  let state: JobState = "queued";
  if (handle !== undefined) {
    try {
      const dispatched = await client.dispatch({ task: taskId, to: handle, run: runId });
      dispatchId = pickIdDeep(unwrapResult(dispatched), DISPATCH_ID_KEYS) ?? null;
      state = "running";
    } catch (error) {
      warnings.push(
        `dispatch 失敗: ${error instanceof Error ? error.message : String(error)} — タスクは作成済み`,
      );
    }
  } else {
    warnings.push(
      kind === "new_worktree"
        ? "新規 worktree のエージェントターミナル handle が取得できませんでした — タスクは作成済み"
        : "対象 worktree に稼働中ターミナルがありません — タスクは作成済み",
    );
  }

  return {
    taskId,
    state,
    runId,
    target: {
      kind,
      worktree: worktreeSelector ?? null,
      terminal: handle ?? null,
      agent: kind === "terminal" ? (input.agent ?? null) : agent,
    },
    dispatchId,
    warnings,
  };
}

function pickObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

async function firstTerminalHandle(client: OrcaClient, worktreeSelector: string): Promise<string | undefined> {
  const listed = await client.terminalList({ worktree: worktreeSelector, limit: 20 });
  const source = unwrapResult(listed);
  const terminals = Array.isArray(source["terminals"]) ? source["terminals"].filter(isJsonObject) : [];
  const live = terminals.filter((terminal) => terminal["connected"] !== false);
  const handle = live
    .map((terminal) => pickString(terminal, ["handle", "terminalHandle", "terminal_handle"]))
    .find((value) => value !== undefined);
  return handle;
}

/** poll: 現在の state / phase / workers を正規化して返す。 */
export async function getTaskStatus(client: OrcaClient, input: TaskStatusInput): Promise<JsonObject> {
  const list = await client.taskList({ run: input.run, brief: false });
  const task = findTaskById(list, input.taskId);
  const rawStatus = pickString(task, ["status", "state", "taskStatus"]);
  const state = mapTaskState(rawStatus);

  const dispatchesPayload = await client.dispatchShow(input.taskId);
  const dispatches = extractDispatches(dispatchesPayload);
  const dispatchIds = new Set(
    dispatches.map((dispatch) => pickString(dispatch, DISPATCH_ID_KEYS)).filter(
      (value): value is string => value !== undefined,
    ),
  );

  const workersPayload = await client.workerList({ run: input.run, limit: 100 });
  const allWorkers = extractWorkers(workersPayload).map(toWorkerRow);
  // dispatch が特定できているときは、その dispatch に紐づく worker だけを見せる
  const workers = allWorkers.filter(
    (worker) => typeof worker["dispatchId"] === "string" && dispatchIds.has(worker["dispatchId"] as string),
  );

  const gatesPayload = await client.gateList({ task: input.taskId, run: input.run });
  const gates = extractGates(gatesPayload).map((gate) => ({
    id: pickString(gate, ["gateId", "gate_id", "id"]) ?? null,
    status: pickString(gate, ["status", "state"]) ?? null,
  }));

  const phase = estimatePhase(state, workers, gates);
  return {
    taskId: input.taskId,
    state,
    phase,
    rawStatus: rawStatus ?? null,
    title: pickString(task, ["title", "taskTitle", "displayName"]) ?? null,
    specPreview: preview(task["spec"], 200),
    workers,
    gates,
    dispatchIds: [...dispatchIds],
    updatedAt: task["updatedAt"] ?? task["updated_at"] ?? null,
    nextAction: nextActionHint(state, phase),
  };
}

/** result: 完了時の result と worker 出力のし尾部を読む(読み取りのみ)。 */
export async function getTaskResult(client: OrcaClient, input: TaskResultInput): Promise<JsonObject> {
  const list = await client.taskList({ run: input.run, brief: false });
  const task = findTaskById(list, input.taskId);
  const rawStatus = pickString(task, ["status", "state", "taskStatus"]);
  const state = mapTaskState(rawStatus);

  const dispatchesPayload = await client.dispatchShow(input.taskId);
  const dispatchIds = extractDispatches(dispatchesPayload)
    .map((dispatch) => pickString(dispatch, DISPATCH_ID_KEYS))
    .filter((value): value is string => value !== undefined);

  const limit = input.outputLimit ?? 40;
  const outputs: JsonObject[] = [];
  for (const dispatchId of dispatchIds.slice(0, 3)) {
    try {
      const read = unwrapResult(await client.workerRead({ dispatch: dispatchId, limit }));
      outputs.push({
        dispatchId,
        agent: pickString(read, AGENT_KEYS) ?? null,
        source: read["source"] ?? null,
        text: preview(read["text"] ?? read["output"] ?? read["transcript"], 4000),
        cursor: read["cursor"] ?? null,
      });
    } catch (error) {
      outputs.push({
        dispatchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    taskId: input.taskId,
    state,
    rawStatus: rawStatus ?? null,
    result: task["result"] ?? null,
    resultPreview: preview(task["result"], 2000),
    outputs,
    finishedAt: task["completedAt"] ?? task["finishedAt"] ?? task["updatedAt"] ?? null,
  };
}
