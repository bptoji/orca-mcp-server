import { execFile } from "node:child_process";

/**
 * orca CLI を 1 回実行する最下層(心臓部)。
 *
 * セキュリティ原則:
 *  - shell を絶対に使わない(shell: false 固定)。
 *  - 引数は必ず argv 配列で渡す。文字列結合でコマンドを組み立てない
 *    (`exec("orca " + userInput)` は command injection につながる)。
 *  - バイナリは resolveOrcaBin() が返す単一の実行ファイルで、execFile(bin, args) で起動する。
 */

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** 失敗の種別。呼び出し側は文字列一致で分岐できる安定した識別子のみを使う。 */
export type OrcaErrorCode =
  | "spawn_failed" // バイナリ起動失敗(ENOENT など)
  | "timeout" // 実行が timeoutMs を超過
  | "max_buffer_exceeded" // stdout/stderr が上限超過
  | "non_zero_exit" // orca が非ゼロ終了
  | "invalid_json"; // --json なのに出力が JSON でない

export interface OrcaCommandFailure {
  code: string;
  message: string;
}

/**
 * orca CLI 自身の JSON エンベロープが運ぶ意味論的な失敗(`ok:false` + `error`)。
 * 終了コードの分類(OrcaErrorCode)とは別軸で、CLI が「なぜ出来なかったか」を返す。
 * 例: `run_required` / `worktree_not_found` など。
 */
export interface OrcaEnvelopeError {
  code: string;
  message: string;
  /** CLI が返す追加情報(nextSteps など)。そのまま応答に載せる。 */
  data?: unknown;
}

export interface OrcaCommandResult<T = unknown> {
  ok: boolean;
  /** ok: true かつ stdout が JSON のときの解析結果。 */
  data?: T;
  /** ok: false のときの失敗情報。 */
  error?: OrcaCommandFailure;
  /**
   * stdout の JSON が `ok:false` エンベロープのときの CLI 側エラー。
   * 終了コードが 0 でも 1 でも入り得る(transport の成否とは別に判定する)。
   */
  orcaError?: OrcaEnvelopeError;
  /** 実行に使われた完全な argv(診断用)。 */
  args: string[];
  /** 子プロセスの終了コード。起動失敗時は -1。 */
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  /** 子プロセスに追加で渡す環境変数(マージして使用)。 */
  env?: Record<string, string>;
  /** buildArgs 用: 末尾に --json を付けるかどうか(既定 true)。 */
  json?: boolean;
}

/** 実行関数の型。テストでは子プロセスを起動しないモックを注入できる。 */
export type CommandRunner = (
  args: string[],
  options?: RunOptions,
) => Promise<OrcaCommandResult>;

/** orca CLI 実行の失敗を表す例外(クライアント層で throw する)。 */
export class OrcaCommandError extends Error {
  readonly code: string;
  readonly args: string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** CLI 側エラーが運ぶ追加情報(nextSteps など)。 */
  readonly data?: unknown;

  constructor(failure: OrcaCommandFailure, result: OrcaCommandResult) {
    super(`orca ${result.args.join(" ")} 失敗 [${failure.code}]: ${failure.message}`);
    this.name = "OrcaCommandError";
    this.code = failure.code;
    this.args = result.args;
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.data = (failure as OrcaEnvelopeError).data;
  }
}

/** サブコマンド配列から argv を組み立てる純関数。`--json` はここでだけ付与する。 */
export function buildArgs(subcommand: string[], options: RunOptions = {}): string[] {
  const args = [...subcommand];
  if (options.json ?? true) {
    args.push("--json");
  }
  return args;
}

/** orca バイナリのパス解決。`ORCA_BIN` 環境変数があればそれを優先する。 */
export function resolveOrcaBin(env: Record<string, string | undefined> = process.env): string {
  const custom = env["ORCA_BIN"]?.trim();
  return custom && custom.length > 0 ? custom : "orca";
}

/** stdout の JSON パース。空文字は undefined、不正 JSON は失敗を返す(テスト対象)。 */
export function parseJsonOutput<T = unknown>(
  stdout: string,
): { ok: true; data: T | undefined } | { ok: false; message: string } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { ok: true, data: undefined };
  }
  try {
    return { ok: true, data: JSON.parse(trimmed) as T };
  } catch {
    return { ok: false, message: "stdout を JSON として解析できませんでした" };
  }
}

/**
 * stdout の JSON が orca CLI の `ok:false` エンベロープのとき、CLI 側エラーを取り出す。
 * 該当しなければ undefined(テスト対象)。
 */
export function extractEnvelopeError(data: unknown): OrcaEnvelopeError | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const envelope = data as Record<string, unknown>;
  if (envelope["ok"] !== false) {
    return undefined;
  }
  const raw = envelope["error"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const cliError = raw as Record<string, unknown>;
  const code =
    typeof cliError["code"] === "string" && cliError["code"].length > 0
      ? cliError["code"]
      : "cli_error";
  const message =
    typeof cliError["message"] === "string" && cliError["message"].length > 0
      ? cliError["message"]
      : "orca CLI が ok:false を返しました";
  return { code, message, data: cliError["data"] };
}

/**
 * stdout の JSON が orca CLI の `ok:true` エンベロープかどうか。
 * 実測: `worker-start` は agent_readiness 失敗時に **ok:true の receipt を出して終了コード 1** で抜ける。
 * エンベロープが意味論の主人なので、このケースは transport 成功として扱う(AGENTS.md 参照)。
 */
export function isOkEnvelope(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  return (data as Record<string, unknown>)["ok"] === true;
}

/**
 * `execFile("orca", args)` で orca CLI を実行し、成否を OrcaCommandResult で返す。
 * 非ゼロ終了でも例外を投げない — 呼び出し側は result.ok / result.error.code で分岐する。
 *
 * @example
 * const result = await runOrca(["status", "--json"]);
 * if (result.ok) { use(result.data); }
 */
export function runOrca<T = unknown>(
  args: string[],
  options: RunOptions = {},
): Promise<OrcaCommandResult<T>> {
  const mergedEnv = options.env ? { ...process.env, ...options.env } : process.env;
  const bin = resolveOrcaBin(mergedEnv);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  return new Promise<OrcaCommandResult<T>>((resolve) => {
    execFile(
      bin,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer,
        windowsHide: true,
        shell: false,
        env: mergedEnv as NodeJS.ProcessEnv,
      },
      (rawError, stdout, stderr) => {
        const base = {
          args,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        };
        const error = rawError as
          | (NodeJS.ErrnoException & { killed?: boolean; signal?: string })
          | null;

        if (error !== null) {
          // 1) 起動失敗(ENOENT など): code が文字列で、killed でない
          if (typeof error.code === "string") {
            resolve({
              ...base,
              ok: false,
              exitCode: -1,
              error: {
                code: error.code === "ENOENT" ? "spawn_failed" : "spawn_failed",
                message:
                  error.code === "ENOENT"
                    ? `orca 実行ファイルが見つかりません (bin: ${bin})。ORCA_BIN を確認してください`
                    : `${error.code}: ${error.message}`,
              },
            });
            return;
          }
          // 2) maxBuffer 超過(殺される) / タイムアウト
          //    注意: 正常な非ゼロ終了では signal は null(Windows 含む)。null を混同しない。
          if (error.killed === true || (error.signal !== undefined && error.signal !== null)) {
            const isMaxBuffer = error.message.includes("maxBuffer");
            resolve({
              ...base,
              ok: false,
              exitCode: -1,
              error: {
                code: isMaxBuffer ? "max_buffer_exceeded" : "timeout",
                message: isMaxBuffer
                  ? `出力が maxBuffer (${maxBuffer} bytes) を超過しました`
                  : `実行が ${timeoutMs}ms を超過したため SIGKILL しました`,
              },
            });
            return;
          }
          // 3) 非ゼロ終了: execFile は終了コードを number の code に入れる
          if (typeof error.code === "number") {
            // stdout に ok:false エンベロープがあれば CLI 側の理由を優先して載せる
            const parsedFailure = parseJsonOutput<T>(base.stdout);
            const cliError = parsedFailure.ok
              ? extractEnvelopeError(parsedFailure.data)
              : undefined;
            // ok:true エンベロープが出ているなら CLI は意味論に成功している(worker-start の
            // readiness 失敗 receipt がこれで抜ける)。終了コードは診断値としてだけ残す。
            if (parsedFailure.ok && cliError === undefined && isOkEnvelope(parsedFailure.data)) {
              resolve({
                ...base,
                ok: true,
                exitCode: error.code,
                data: parsedFailure.data,
              });
              return;
            }
            resolve({
              ...base,
              ok: false,
              exitCode: error.code,
              error: {
                code: "non_zero_exit",
                message:
                  cliError !== undefined
                    ? `終了コード ${error.code}: [${cliError.code}] ${cliError.message}`
                    : stderr.trim().length > 0
                      ? `終了コード ${error.code}: ${stderr.trim()}`
                      : `終了コード ${error.code}`,
              },
              ...(cliError !== undefined ? { orcaError: cliError } : {}),
            });
            return;
          }
          resolve({
            ...base,
            ok: false,
            exitCode: -1,
            error: { code: "spawn_failed", message: error.message },
          });
          return;
        }

        // 正常終了: JSON 解析
        const parsed = parseJsonOutput<T>(stdout ?? "");
        if (parsed.ok === false) {
          resolve({
            ...base,
            ok: false,
            exitCode: 0,
            error: { code: "invalid_json", message: parsed.message },
          });
          return;
        }
        // 終了コード 0 でも ok:false エンベロープがあり得る(transport は成功 / CLI は失敗)
        const cliError = extractEnvelopeError(parsed.data);
        resolve({
          ...base,
          ok: true,
          exitCode: 0,
          data: parsed.data,
          ...(cliError !== undefined ? { orcaError: cliError } : {}),
        });
      },
    );
  });
};
