import {
  buildArgs,
  OrcaCommandError,
  runOrca,
  type CommandRunner,
  type OrcaCommandResult,
  type RunOptions,
} from "./command.js";

/** orca CLI の JSON 出力の共通形状(キーはコマンドごとに異なる)。 */
export type JsonObject = Record<string, unknown>;

/**
 * worker-start 専用の transport timeout。worktree 作成 + setup hook + エージェント起動 +
 * 初ターン観測まで同期で走るため、既定の 30s では足りない(実機 E2E で 30s 超を経験した)。
 */
const WORKER_START_TIMEOUT_MS = 180_000;

export interface WorktreeListInput {
  repo?: string;
  limit?: number;
}

export interface WorktreeShowInput {
  worktree: string;
}

export interface WorktreeCreateInput {
  name: string;
  repo?: string;
  agent?: string;
  prompt?: string;
  setup?: "run" | "skip" | "inherit";
  baseBranch?: string;
  comment?: string;
  parentWorktree?: string;
  noParent?: boolean;
}

export interface TerminalListInput {
  worktree?: string;
  limit?: number;
}

export interface WorkerListInput {
  run?: string;
  terminalState?: string;
  limit?: number;
  cursor?: string;
}

export interface WorkerReadInput {
  dispatch: string;
  source?: "auto" | "transcript" | "terminal";
  cursor?: string;
  limit?: number;
}

export interface GateListInput {
  task?: string;
  status?: string;
  run?: string;
  from?: string;
}

/** `gate-resolve` には `--run` が無い(Run スコープは呼び出し元のバインドで決まる)。 */
export interface GateResolveInput {
  id: string;
  resolution: string;
  from?: string;
}

export interface TaskCreateInput {
  spec: string;
  title?: string;
  displayName?: string;
  deps?: string[];
  parent?: string;
  run?: string;
  from?: string;
}

export interface TaskListInput {
  status?: string;
  ready?: boolean;
  brief?: boolean;
  run?: string;
  from?: string;
}

export interface TaskUpdateInput {
  id: string;
  status: string;
  result?: string;
  run?: string;
  from?: string;
}

export interface DispatchInput {
  task: string;
  to: string;
  from?: string;
  run?: string;
  inject?: boolean;
}

export interface WorkerStartInput {
  task: string;
  agent: string;
  worktree: "current" | "new-child" | "new-top-level";
  name?: string;
  repo?: string;
  setup?: "run" | "skip" | "inherit";
  /** 1.4.245: provider の model id(Claude / Codex / Cursor / Antigravity / Muse が対応)。 */
  model?: string;
  /** 1.4.245: 推論レベル。CLI は `--effort requires --model` で model 無しを拒否する。 */
  effort?: string;
  run?: string;
  from?: string;
}

export interface DispatchShowInput {
  preamble?: boolean;
  from?: string;
}

export interface RunListInput {
  limit?: number;
  cursor?: string;
}

export interface SendInput {
  subject: string;
  to?: string;
  body?: string;
  type?: string;
  /** `worker_done` は CLI 側で `--outcome succeeded|failed` が必須(無いと CLI が拒否する)。 */
  outcome?: "succeeded" | "failed";
  priority?: string;
  threadId?: string;
  taskId?: string;
  dispatchId?: string;
  run?: string;
}

export interface CheckInput {  terminal?: string;
  run?: string;
  ack?: string;
  mode?: "unread" | "peek" | "all";
  types?: string[];
  wait?: boolean;
  timeoutMs?: number;
}

export interface ReplyInput {
  id: string;
  body: string;
  run?: string;
  from?: string;
}

export interface InboxInput {
  limit?: number;
  terminal?: string;
  full?: boolean;
}

/** JSON オブジェクトとして扱える形に寄せる(配列・プリミティブは raw に包む)。 */
export function asJsonObject(data: unknown): JsonObject {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as JsonObject;
  }
  return { raw: data ?? null };
}

/** 応答からタスク ID を拾うためのキー候補。 */
const TASK_ID_KEYS = ["taskId", "task_id", "id"] as const;

/** task-create 応答のような JSON からタスク ID を取り出す(テスト対象)。 */
export function extractTaskId(result: JsonObject): string | undefined {
  for (const key of TASK_ID_KEYS) {
    const value = result[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  const nested = result["task"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return extractTaskId(nested as JsonObject);
  }
  return undefined;
}

/** task-list 応答のような JSON からタスク配列を取り出す(テスト対象)。 */
export function extractTasks(result: JsonObject): JsonObject[] {
  const candidates = [result["tasks"], result["items"], result["data"], result];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (item): item is JsonObject => item !== null && typeof item === "object" && !Array.isArray(item),
      );
    }
  }
  return [];
}

/**
 * orca CLI を型付きメソッドで叩くクライアント。
 * runner を注入できるので、テストでは子プロセスを実際に起動せずに検証できる。
 */
/**
 * orchestration サブコマンドには常に `--full` を付ける(テスト対象)。
 *
 * Orca 1.4.246(PR #36498、2026-10-31)から orchestration の出力は既定でエージェント向けの簡易表示になり、
 * `--full` で従来のプリンタ(1.4.245 までと同じ出力)に戻る。簡易表示は項目を落とすだけでなく、失敗時の
 * `ok` / 終了コードや envelope の形も変える。2026-11-08 実測(1.4.250)で簡易表示に無かった項目:
 * task-list の parent_id / result / created_by_* / created_at、worker-list の agentTerminalHandle /
 * workerState / projection / resource / page、worker-show の observation、run-list の coordinator_handle、
 * inbox の thread_id / read。orca-mcp の正規化はすべて従来の出力を前提にしているので、一律に `--full` で読む。
 * `--full` は 1.4.246 以上が必要(それ以前の CLI は未知のフラグとして拒否する)。
 */
export function withFullRecord(subcommand: string[]): string[] {
  if (subcommand[0] !== "orchestration" || subcommand.includes("--full")) {
    return subcommand;
  }
  return [...subcommand, "--full"];
}

export class OrcaClient {
  private readonly runner: CommandRunner;
  private readonly defaults: RunOptions;

  constructor(runner: CommandRunner = runOrca, defaults: RunOptions = {}) {
    this.runner = runner;
    this.defaults = defaults;
  }

  private async call(subcommand: string[], options: RunOptions = {}): Promise<JsonObject> {
    const args = buildArgs(withFullRecord(subcommand));
    const result: OrcaCommandResult = await this.runner(args, {
      ...this.defaults,
      ...options,
    });
    if (!result.ok) {
      // CLI 自身が ok:false を返しているときは、transport の code(non_zero_exit など)より
      // CLI 側の理由(run_required など)を優先して呼び出し側に渡す。
      const failure = result.orcaError ?? result.error ?? {
        code: "spawn_failed",
        message: result.stderr.trim() || result.stdout.trim() || "出力なし",
      };
      throw new OrcaCommandError(failure, result);
    }
    // 終了コード 0 で ok:false が返ることがある(CLI 側の理由が本体)。それを例外化して
    // ツール層に code / data(nextSteps など)まで渡す。
    if (result.orcaError !== undefined) {
      throw new OrcaCommandError(result.orcaError, result);
    }
    return asJsonObject(result.data);
  }

  /** `orca status` — アプリ/ランタイム/グラフの準備状態。 */
  status(): Promise<JsonObject> {
    return this.call(["status"]);
  }

  /** `orca skills installed` — インストール済み skill の selector 一覧(read-only)。 */
  skillsInstalled(): Promise<JsonObject> {
    return this.call(["skills", "installed"]);
  }

  /** `orca worktree list` — Orca 管理ワークツリーの一覧。 */
  worktreeList(input: WorktreeListInput = {}): Promise<JsonObject> {
    const args = ["worktree", "list"];
    if (input.repo !== undefined) args.push("--repo", input.repo);
    if (input.limit !== undefined) args.push("--limit", String(input.limit));
    return this.call(args);
  }

  /** `orca worktree show` — 1 件のワークツリー詳細(セレクタ指定)。 */
  worktreeShow(input: WorktreeShowInput): Promise<JsonObject> {
    return this.call(["worktree", "show", "--worktree", input.worktree]);
  }

  /** `orca worktree ps` — ワークツリー横断のオーケストレーション要約(agents を含む)。 */
  worktreePs(limit?: number): Promise<JsonObject> {
    const args = ["worktree", "ps"];
    if (limit !== undefined) {
      args.push("--limit", String(limit));
    }
    return this.call(args);
  }

  /** `orca worktree create` — 新しいチェックアウト(任意でエージェントも起動)。 */
  worktreeCreate(input: WorktreeCreateInput): Promise<JsonObject> {
    const args = ["worktree", "create", "--name", input.name];
    if (input.repo !== undefined) args.push("--repo", input.repo);
    if (input.agent !== undefined) args.push("--agent", input.agent);
    if (input.prompt !== undefined) args.push("--prompt", input.prompt);
    if (input.setup !== undefined) args.push("--setup", input.setup);
    if (input.baseBranch !== undefined) args.push("--base-branch", input.baseBranch);
    if (input.comment !== undefined) args.push("--comment", input.comment);
    if (input.parentWorktree !== undefined) args.push("--parent-worktree", input.parentWorktree);
    if (input.noParent === true) args.push("--no-parent");
    return this.call(args);
  }

  /** `orca terminal list` — 稼働中ターミナル(handle 取得用)。 */
  terminalList(input: TerminalListInput = {}): Promise<JsonObject> {
    const args = ["terminal", "list"];
    if (input.worktree !== undefined) args.push("--worktree", input.worktree);
    if (input.limit !== undefined) args.push("--limit", String(input.limit));
    return this.call(args);
  }

  /** `orca orchestration worker-list` — worker のリソース計上。 */
  workerList(input: WorkerListInput = {}): Promise<JsonObject> {
    const args = ["orchestration", "worker-list"];
    if (input.run !== undefined) args.push("--run", input.run);
    if (input.terminalState !== undefined) args.push("--terminal-state", input.terminalState);
    if (input.limit !== undefined) args.push("--limit", String(input.limit));
    if (input.cursor !== undefined) args.push("--cursor", input.cursor);
    return this.call(args);
  }

  /** `orca orchestration worker-show` — 1 つの dispatch の worker 詳細。 */
  workerShow(dispatch: string): Promise<JsonObject> {
    return this.call(["orchestration", "worker-show", "--dispatch", dispatch]);
  }

  /** `orca orchestration worker-abandon` — 不確実な worker を fence する(プロセスは触らない)。 */
  workerAbandon(dispatch: string): Promise<JsonObject> {
    return this.call(["orchestration", "worker-abandon", "--dispatch", dispatch]);
  }

  /** `orca orchestration worker-stop` — dispatch を fence して worker を止める。 */
  workerStop(dispatch: string): Promise<JsonObject> {
    return this.call(["orchestration", "worker-stop", "--dispatch", dispatch]);
  }

  /**
   * `orca orchestration worker-release` — settled な worker の agent terminal を閉じる(1.4.245)。
   * 出力は閉じる前に archive されるので worker-read は引き続き読める。冪等(2 回目は already_released)。
   */
  workerRelease(dispatch: string): Promise<JsonObject> {
    return this.call(["orchestration", "worker-release", "--dispatch", dispatch]);
  }

  /** `orca orchestration worker-read` — worker の出力(読み取り)。 */
  workerRead(input: WorkerReadInput): Promise<JsonObject> {
    const args = ["orchestration", "worker-read", "--dispatch", input.dispatch];
    if (input.source !== undefined) args.push("--source", input.source);
    if (input.cursor !== undefined) args.push("--cursor", input.cursor);
    if (input.limit !== undefined) args.push("--limit", String(input.limit));
    return this.call(args);
  }

  /** `orca orchestration gate-list` — 意思決定ゲート(blocked の理由になり得る)。 */
  gateList(input: GateListInput = {}): Promise<JsonObject> {
    const args = ["orchestration", "gate-list"];
    if (input.task !== undefined) args.push("--task", input.task);
    if (input.status !== undefined) args.push("--status", input.status);
    if (input.run !== undefined) args.push("--run", input.run);
    if (input.from !== undefined) args.push("--from", input.from);
    return this.call(args);
  }

  /** `orca orchestration gate-resolve` — pending の判断ゲートを承認/却下で解決する。 */
  gateResolve(input: GateResolveInput): Promise<JsonObject> {
    const args = ["orchestration", "gate-resolve", "--id", input.id, "--resolution", input.resolution];
    if (input.from !== undefined) args.push("--from", input.from);
    return this.call(args);
  }

  /** `orca orchestration task-create` */
  taskCreate(input: TaskCreateInput): Promise<JsonObject> {
    const args = ["orchestration", "task-create", "--spec", input.spec];
    if (input.title !== undefined) args.push("--task-title", input.title);
    if (input.displayName !== undefined) args.push("--display-name", input.displayName);
    if (input.deps !== undefined && input.deps.length > 0) {
      args.push("--deps", JSON.stringify(input.deps));
    }
    if (input.parent !== undefined) args.push("--parent", input.parent);
    if (input.run !== undefined) args.push("--run", input.run);
    if (input.from !== undefined) args.push("--from", input.from);
    return this.call(args);
  }

  /** `orca orchestration task-list` */
  taskList(input: TaskListInput = {}): Promise<JsonObject> {
    const args = ["orchestration", "task-list"];
    if (input.status !== undefined) args.push("--status", input.status);
    if (input.ready === true) args.push("--ready");
    if (input.brief === true) args.push("--brief");
    if (input.run !== undefined) args.push("--run", input.run);
    if (input.from !== undefined) args.push("--from", input.from);
    return this.call(args);
  }

  /** `orca orchestration task-update` */
  taskUpdate(input: TaskUpdateInput): Promise<JsonObject> {
    const args = ["orchestration", "task-update", "--id", input.id, "--status", input.status];
    if (input.result !== undefined) args.push("--result", input.result);
    if (input.run !== undefined) args.push("--run", input.run);
    if (input.from !== undefined) args.push("--from", input.from);
    return this.call(args);
  }

  /** `orca orchestration dispatch` — タスクをターミナルへ dispatch する。 */
  dispatch(input: DispatchInput): Promise<JsonObject> {
    const args = ["orchestration", "dispatch", "--task", input.task, "--to", input.to];
    if (input.from !== undefined) args.push("--from", input.from);
    if (input.run !== undefined) args.push("--run", input.run);
    if (input.inject === true) args.push("--inject");
    return this.call(args);
  }

  /** `orca orchestration worker-start` — supervised worker を起動する。 */
  workerStart(input: WorkerStartInput): Promise<JsonObject> {
    const args = [
      "orchestration",
      "worker-start",
      "--task",
      input.task,
      "--worktree",
      input.worktree,
      "--agent",
      input.agent,
    ];
    if (input.name !== undefined) args.push("--name", input.name);
    if (input.repo !== undefined) args.push("--repo", input.repo);
    if (input.setup !== undefined) args.push("--setup", input.setup);
    if (input.model !== undefined) args.push("--model", input.model);
    if (input.effort !== undefined) args.push("--effort", input.effort);
    if (input.run !== undefined) args.push("--run", input.run);
    if (input.from !== undefined) args.push("--from", input.from);
    // worker-start は worktree 作成 + setup hook 実行 + エージェント起動 + 初ターン観測まで
    // 同期で行う(実機で 30s を超えた)。既定 30s の transport timeout だと SIGKILL になるため、
    // このコマンドだけ transport 側の上限を大きく取る。
    return this.call(args, { timeoutMs: WORKER_START_TIMEOUT_MS });
  }

  /** `orca orchestration dispatch-show` — タスクの dispatch 状況。 */
  dispatchShow(task: string, input: DispatchShowInput = {}): Promise<JsonObject> {
    const args = ["orchestration", "dispatch-show", "--task", task];
    if (input.preamble === true) args.push("--preamble");
    if (input.from !== undefined) args.push("--from", input.from);
    return this.call(args);
  }

  /** `orca orchestration send` — エージェント間メッセージ送信。 */
  send(input: SendInput): Promise<JsonObject> {
    const args = ["orchestration", "send", "--subject", input.subject];
    if (input.to !== undefined) args.push("--to", input.to);
    if (input.run !== undefined) args.push("--run", input.run);
    if (input.body !== undefined) args.push("--body", input.body);
    if (input.type !== undefined) args.push("--type", input.type);
    if (input.outcome !== undefined) args.push("--outcome", input.outcome);
    if (input.priority !== undefined) args.push("--priority", input.priority);
    if (input.threadId !== undefined) args.push("--thread-id", input.threadId);
    if (input.taskId !== undefined) args.push("--task-id", input.taskId);
    if (input.dispatchId !== undefined) args.push("--dispatch-id", input.dispatchId);
    return this.call(args);
  }

  /** `orca orchestration check` — 自分のメッセージ受信箱チェック。 */
  check(input: CheckInput = {}): Promise<JsonObject> {
    const args = ["orchestration", "check"];
    if (input.terminal !== undefined) args.push("--terminal", input.terminal);
    if (input.run !== undefined) args.push("--run", input.run);
    if (input.ack !== undefined) args.push("--ack", input.ack);
    if (input.mode === "peek") args.push("--peek");
    if (input.mode === "all") args.push("--all");
    if (input.types !== undefined && input.types.length > 0) {
      args.push("--types", input.types.join(","));
    }
    if (input.wait === true) args.push("--wait");
    if (input.timeoutMs !== undefined) args.push("--timeout-ms", String(input.timeoutMs));
    return this.call(args);
  }

  /** `orca orchestration reply` — メッセージへの返信。 */
  reply(input: ReplyInput): Promise<JsonObject> {
    const args = ["orchestration", "reply", "--id", input.id, "--body", input.body];
    if (input.run !== undefined) args.push("--run", input.run);
    if (input.from !== undefined) args.push("--from", input.from);
    return this.call(args);
  }

  /** `orca orchestration inbox` — 受信者横断のメッセージ一覧。 */
  inbox(input: InboxInput = {}): Promise<JsonObject> {
    const args = ["orchestration", "inbox"];
    if (input.limit !== undefined) args.push("--limit", String(input.limit));
    if (input.terminal !== undefined) args.push("--terminal", input.terminal);
    if (input.full === true) args.push("--full");
    return this.call(args);
  }

  /** `orca orchestration run-create` — オーケストレーション Run の作成。 */
  runCreate(objective: string): Promise<JsonObject> {
    return this.call(["orchestration", "run-create", "--objective", objective]);
  }

  /**
   * `orca orchestration run-list` — Run の一覧(read-only)。
   * 実測応答は `result.runs[]` + `result.nextCursor`(keyset cursor)。
   * 簡易表示の行は `{ id, objective }` だけで `coordinator_handle` が無い(`--full` は call() が付ける)。
   */
  runList(input: RunListInput = {}): Promise<JsonObject> {
    const args = ["orchestration", "run-list"];
    if (input.limit !== undefined) args.push("--limit", String(input.limit));
    if (input.cursor !== undefined) args.push("--cursor", input.cursor);
    return this.call(args);
  }

  /** `orca orchestration run-show` — 1 件の Run 詳細(read-only)。 */
  runShow(runId: string): Promise<JsonObject> {
    return this.call(["orchestration", "run-show", "--id", runId]);
  }

  /** `orca orchestration run-current` — バインド中の Run 表示。 */
  runCurrent(): Promise<JsonObject> {
    return this.call(["orchestration", "run-current"]);
  }

  /** `orca orchestration run-use` — 呼び出し元の Run バインドを切り替える(変更系)。 */
  runUse(runId: string): Promise<JsonObject> {
    return this.call(["orchestration", "run-use", "--id", runId]);
  }
}
