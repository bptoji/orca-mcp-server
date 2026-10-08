// dsh worker 用の最小 launcher: dsh-tui を起動して、その終了を待つだけ。
//
// 問い: ACP ブリッジ(dsh-acp-worker.mjs)は要るのか?
//   dsh-tui は注入を受け付けられる(実測)ので、pane に dsh-tui が立っていて
//   readiness が通るなら、注入はそのまま TUI のプロンプト欄に入り、
//   中のエージェントが worker_done で報告できる。それを実測した最小の launcher がこれ
//   (注入も ACP も何もしない)。
//
// 役割(これだけ):
//   1. dsh-tui の Node エントリを解決する(npm root -g / PATH。shell 文字列は作らない)
//   2. stdio inherit で起動して pane の PTY を TUI に渡す
//   3. TUI が終わるまで pane の foreground プロセスとして生存し続ける
//      (readiness が要求する「pane に生きたプロセスが見えている」を満たす)
//   4. 終了コードを伝え、診断ログをファイルに積む
//
// 使い方:
//   Orca のエージェント設定で dsh の起動コマンド引数を `node <このファイル>` に向ける。
//   対話で dsh-tui を使いたい人は `dst .`(エイリアス)。agentCmdOverrides を通らないので
//   この launcher は関与しない。
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const TAG = "dsh-tui-launcher";
const LOG_FILE = join(tmpdir(), "dsh-tui-launcher.log");
const log = (...parts) => {
  const line = `[${TAG} ${new Date().toISOString().slice(11, 19)} pid=${process.pid}] ${parts.join(" ")}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // ログが書けなくても起動は止めない
  }
};

const resolveTuiBin = () => {
  const candidates = [];
  try {
    const npmShim = process.platform === "win32" ? "npm.cmd" : "npm";
    const root = spawnSync(npmShim, ["root", "-g"], { encoding: "utf8" }).stdout.trim();
    if (root) {
      candidates.push(join(root, "@deepseek-harness-tui", "dsh-tui", "bin", "dsh-tui.js"));
      candidates.push(join(root, "node_modules", "@deepseek-harness-tui", "dsh-tui", "bin", "dsh-tui.js"));
    }
  } catch {
    // npm が無い環境では PATH 経路だけを見る
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    candidates.push(join(dir, "node_modules", "@deepseek-harness-tui", "dsh-tui", "bin", "dsh-tui.js"));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const bin = resolveTuiBin();
log(`launch token = ${process.env.ORCA_AGENT_LAUNCH_TOKEN ? "あり" : "なし"}`);
log(`cwd = ${process.cwd()}`);
if (bin === null) {
  log("dsh-tui の Node エントリを解決できませんでした");
  process.exit(3);
}
log(`dsh-tui = ${bin}`);

const child = spawn(process.execPath, [bin, "."], {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code, signal) => {
  log(`dsh-tui 終了 code=${code} signal=${signal}`);
  process.exit(code ?? (signal === null ? 0 : 1));
});
child.on("error", (error) => {
  log(`起動失敗 ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
});
