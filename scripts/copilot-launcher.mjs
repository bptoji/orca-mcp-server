// copilot worker 用の最小 launcher: COPILOT_ALLOW_ALL=true を設定して copilot を起動し、終了を待つだけ。
//
// 動機(2026-10-08 実測): supervised worker の起動が `agent_readiness` で
// `Agent startup blocked: agent-trust-workspace` に落ちる。pane には
// "Confirm folder trust … Do you trust the files in this folder?" が出て、
// dispatch 経由の注入が届かないため MCP 側・自動化側から答えられない。
//
// 実測で解けたのは env だけ:
//   `COPILOT_ALLOW_ALL=true`(正確に "true") は「working directory を確認なしで信頼する」
//   (copilot help environment)。他の truthy 表記("1" / "yes" / "on")はツールの自動承認だけで trust が残る。
//   `--add-dir .` / `--allow-all-paths` / `--allow-all-tools` では trust プロンプトは消えなかった。
//   `~/.copilot` の trustedFolders は親ディレクトリを信頼しても子 worktree に効かない(完全一致)。
//   Orca 側に `agentDefaultEnv` キーは存在するが UI からの設定経路が見つかっていない(実測)。
//
// なので dsh と同じ launcher 経路で設定する: agentCmdOverrides.copilot = node、
// agentDefaultArgs.copilot = "このファイル" <copilot への追加引数…>。
// 追加引数はそのまま copilot に転送する(例: --allow-all-tools)。
//
// 役割(dsh-tui-launcher.mjs と同じ型):
//   1. copilot の Node エントリを解決する(npm root -g / PATH。shell 文字列は作らない)
//   2. stdio inherit で起動して pane の PTY を copilot に渡す
//   3. copilot が終わるまで pane の foreground プロセスとして生存し続ける
//   4. 終了コードを伝え、診断ログをファイルに積む
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const TAG = "copilot-launcher";
const LOG_FILE = join(tmpdir(), "copilot-launcher.log");
const log = (...parts) => {
  const line = `[${TAG} ${new Date().toISOString().slice(11, 19)} pid=${process.pid}] ${parts.join(" ")}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // ログが書けなくても起動は止めない
  }
};

const resolveCopilotEntry = () => {
  const candidates = [];
  const push = (dir) => {
    if (!dir) return;
    candidates.push(join(dir, "@github", "copilot", "npm-loader.js"));
    candidates.push(join(dir, "node_modules", "@github", "copilot", "npm-loader.js"));
  };
  try {
    const npmShim = process.platform === "win32" ? "npm.cmd" : "npm";
    push(spawnSync(npmShim, ["root", "-g"], { encoding: "utf8" }).stdout.trim());
  } catch {
    // npm が無い環境では PATH 経路だけを見る
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    push(dir);
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const entry = resolveCopilotEntry();
const extraArgs = process.argv.slice(2);
log(`launch token = ${process.env.ORCA_AGENT_LAUNCH_TOKEN ? "あり" : "なし"}`);
log(`cwd = ${process.cwd()}`);
if (entry === null) {
  log("copilot の Node エントリ(@github/copilot/npm-loader.js)を解決できませんでした");
  process.exit(3);
}
log(`copilot = ${entry}`);
log(`追加引数 = ${extraArgs.join(" ") || "無"}`);

// "true" であることが効く(trust の免除)。既に設定されているなら尊重する。
const env = { ...process.env, COPILOT_ALLOW_ALL: process.env.COPILOT_ALLOW_ALL || "true" };
log(`COPILOT_ALLOW_ALL = ${env.COPILOT_ALLOW_ALL}`);

const child = spawn(process.execPath, [entry, ...extraArgs], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code, signal) => {
  log(`copilot 終了 code=${code} signal=${signal}`);
  process.exit(code ?? (signal === null ? 0 : 1));
});
child.on("error", (error) => {
  log(`起動失敗 ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
});
