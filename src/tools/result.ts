import type { CallToolResult } from "@modelcontextprotocol/server";
import { OrcaCommandError } from "../orca/command.js";

/** 成功応答: JSON を整形した 1 本のテキスト。 */
export function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * 失敗を MCP 応答へ変換する。
 * OrcaCommandError なら code / args / exitCode / data(CLI の nextSteps など)を載せ、
 * プロトコル例外にせず isError: true の結果として返す(モデルが読める形)。
 */
export function errorResult(error: unknown): CallToolResult {
  if (error instanceof OrcaCommandError) {
    const payload: Record<string, unknown> = {
      ok: false,
      code: error.code,
      message: error.message,
      args: error.args,
      exitCode: error.exitCode,
    };
    if (error.data !== undefined) payload["data"] = error.data;
    if (error.stderr.trim().length > 0) payload["stderr"] = error.stderr.trim();
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 成功/失敗の両方を 1 行で返すためのラッパー(ツールハンドラー内で使う)。 */
export async function resultOf(
  run: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return textResult(await run());
  } catch (error) {
    return errorResult(error);
  }
}
