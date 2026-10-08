import { describe, expect, it } from "vitest";
import {
  buildArgs,
  extractEnvelopeError,
  parseJsonOutput,
  resolveOrcaBin,
  runOrca,
  type RunOptions,
} from "../src/orca/command.js";

describe("buildArgs", () => {
  it("既定で --json が末尾に付く", () => {
    expect(buildArgs(["status"])).toEqual(["status", "--json"]);
  });

  it("サブコマンド配列はそのまま先頭に並ぶ", () => {
    expect(buildArgs(["orchestration", "task-list", "--brief"])).toEqual([
      "orchestration",
      "task-list",
      "--brief",
      "--json",
    ]);
  });

  it("json: false では --json を付与しない", () => {
    expect(buildArgs(["status"], { json: false })).toEqual(["status"]);
  });

  it("呼び出し側の配列を書き換えない", () => {
    const subcommand = ["status"];
    buildArgs(subcommand);
    expect(subcommand).toEqual(["status"]);
  });
});

describe("resolveOrcaBin", () => {
  it("ORCA_BIN があればそれを優先する", () => {
    expect(resolveOrcaBin({ ORCA_BIN: "C:\\tools\\orca.exe" })).toBe("C:\\tools\\orca.exe");
  });

  it("空・空白の ORCA_BIN では orca にフォールバックする", () => {
    expect(resolveOrcaBin({ ORCA_BIN: "   " })).toBe("orca");
    expect(resolveOrcaBin({})).toBe("orca");
  });
});

describe("parseJsonOutput", () => {
  it("JSON をパースする", () => {
    expect(parseJsonOutput('{"ok":true}\n')).toEqual({ ok: true, data: { ok: true } });
  });

  it("空文字は ok: true / data: undefined", () => {
    expect(parseJsonOutput("")).toEqual({ ok: true, data: undefined });
  });

  it("不正 JSON は ok: false", () => {
    const parsed = parseJsonOutput("not json");
    expect(parsed.ok).toBe(false);
  });
});

/**
 * runOrca の実挙動テスト。本物の orca は起動せず、
 * ORCA_BIN に node 自身を指定して「偽 orca」にする(hermetic)。
 */
const fakeEnv = { ORCA_BIN: process.execPath };

function fakeRun(script: string, extraArgs: string[] = [], options: RunOptions = {}) {
  return runOrca(["-e", script, ...extraArgs], { env: fakeEnv, ...options });
}

describe("runOrca (execFile ベース)", () => {
  it("正常終了 + JSON 出力 → ok: true / data", async () => {
    const result = await fakeRun("process.stdout.write(JSON.stringify({ hello: 'world' }))");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ hello: "world" });
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("JSON 出力なしの正常終了 → ok: true / data: undefined", async () => {
    const result = await fakeRun("process.stdout.write('')");
    expect(result.ok).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it("非ゼロ終了 → ok: false / non_zero_exit(例外は投げない)", async () => {
    const result = await fakeRun("process.stderr.write('boom'); process.exit(3)");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("non_zero_exit");
    expect(result.error?.message).toContain("boom");
    expect(result.exitCode).toBe(3);
  });

  it("バイナリ不在 → ok: false / spawn_failed", async () => {
    const result = await runOrca(["status", "--json"], {
      env: { ORCA_BIN: "this-binary-does-not-exist-xyz" },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("spawn_failed");
    expect(result.exitCode).toBe(-1);
  });

  it("タイムアウト → ok: false / timeout", async () => {
    const result = await fakeRun("setTimeout(() => {}, 10_000)", [], { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("timeout");
  });

  it("--json なのに JSON でない出力 → ok: false / invalid_json", async () => {
    const result = await fakeRun("process.stdout.write('orca says hi')");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_json");
  });

  it("shell メタ文字を含む引数は 1 つの argv としてそのまま渡る(injection 防止)", async () => {
    const evil = "a b && echo pwned; $(calc) | tail";
    const result = await fakeRun(
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      [evil],
    );
    expect(result.ok).toBe(true);
    // node -e ではスクリプトは argv に入らず、悪意ある文字列が単一要素として届く
    expect(result.data).toEqual([evil]);
  });

  it("非ゼロ終了 + ok:false エンベロープ → non_zero_exit に CLI 側の code を添える", async () => {
    const script =
      "process.stdout.write(JSON.stringify({ok:false,error:{code:'run_required',message:'No Run is bound.',data:{nextSteps:['run-create']}}})); process.exit(1)";
    const result = await fakeRun(script);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("non_zero_exit");
    expect(result.error?.message).toContain("run_required");
    expect(result.orcaError?.code).toBe("run_required");
    expect(result.orcaError?.data).toEqual({ nextSteps: ["run-create"] });
  });

  it("非ゼロ終了 + ok:true エンベロープ → transport 成功として data を返す(worker-start の readiness 失敗 receipt)", async () => {
    // 実測: worker-start は agent_readiness 失敗時に ok:true の receipt を出して終了コード 1 で抜ける。
    // 終了コードではなくエンベロープを意味論の主人として扱う(AGENTS.md)。
    const script =
      "process.stdout.write(JSON.stringify({ok:true,result:{state:'failed',stage:'agent_readiness',lastError:'timeout'}})); process.exit(1)";
    const result = await fakeRun(script);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ ok: true });
  });

  it("終了コード 0 + ok:false エンベロープ → ok: true のまま orcaError に理由を載せる", async () => {
    const script =
      "process.stdout.write(JSON.stringify({ok:false,error:{code:'worktree_not_found',message:'nope'}}))";
    const result = await fakeRun(script);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ ok: false });
    expect(result.orcaError?.code).toBe("worktree_not_found");
  });

  it("ok:true 応答では orcaError を付けない", async () => {
    const result = await fakeRun("process.stdout.write(JSON.stringify({ok:true,result:{}}))");
    expect(result.orcaError).toBeUndefined();
  });
});

describe("extractEnvelopeError", () => {
  it("ok:false + error から code / message / data を取り出す", () => {
    const cliError = extractEnvelopeError({
      ok: false,
      error: { code: "run_required", message: "No Run is bound.", data: { effectsApplied: false } },
    });
    expect(cliError).toEqual({
      code: "run_required",
      message: "No Run is bound.",
      data: { effectsApplied: false },
    });
  });

  it("ok:true / 非オブジェクト / error 欠損では undefined", () => {
    expect(extractEnvelopeError({ ok: true, result: {} })).toBeUndefined();
    expect(extractEnvelopeError(null)).toBeUndefined();
    expect(extractEnvelopeError("boom")).toBeUndefined();
    expect(extractEnvelopeError([1, 2])).toBeUndefined();
    expect(extractEnvelopeError({ ok: false })).toBeUndefined();
  });

  it("code / message が無ければ安定した既定値に落とす", () => {
    expect(extractEnvelopeError({ ok: false, error: {} })).toEqual({
      code: "cli_error",
      message: "orca CLI が ok:false を返しました",
      data: undefined,
    });
  });
});
