# 変更履歴

このプロジェクトのバージョンは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

- パッチ: バグ修正、ツールの入出力を変えない Orca CLI への追従
- マイナー: 機能の追加(新しいツール、応答への項目追加、`blockedReasons` の新しい kind など)
- メジャー: 利用側が壊れる変更(ツール・入力項目の削除や改名、必要な Orca CLI の最低バージョンの引き上げ)

## [未リリース]

## [1.0.0] - 2026-11-23

最初のリリース。Orca CLI 1.4.246 以上 / Node.js 20 以上が前提。

- 非同期 Job API: `orca_delegate_task`(Commander への委譲)/ `orca_get_task_status`(poll)/ `orca_get_task_result`
- 介入: `orca_send_message` / `orca_reply_message` / `orca_resolve_gate` / `orca_cancel_task` / `orca_release_task`
- 観測: `orca_status` / `orca_readiness` / `orca_list_worktrees` / `orca_get_worktree` / `orca_list_agents` /
  `orca_list_runs` / `orca_get_run`
- Commander が作る子 Run(sub-run)の観測・所有判定・cascade cancel
- poll の `blockedReasons`(`gate` / `ask` / `ask_undelivered` / `task_report` / `agent_auth` / `agent_prompt` /
  `turn_unobserved` / `unknown`)
- stdio と Streamable HTTP(stateless、Host / Origin / Bearer の検証付き)のトランスポート

[未リリース]: https://github.com/bptoji/orca-mcp-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/bptoji/orca-mcp-server/releases/tag/v1.0.0
