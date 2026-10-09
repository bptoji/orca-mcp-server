# 設計案: Streamable HTTP トランスポート(stdio 既定のまま)

状態: **設計案(未実装)/ レビュー反映済み**。ベースは `master`(`cd3e6f3`)。
参考にする旧実装は `4ae6958`(旧ブランチは削除済み、パッチは `%TEMP%\orca-mcp-transport-ref\` に退避)。
レビュー(`orca-mcp_review6.txt`)の 4 点の指摘を反映し、指摘内容が実機 SDK で事実かを確認した。

## 目的と非目的

- **目的**: 別 PC / 別プロセスの MCP クライアントが orca-mcp を呼べるようにする
- **非目的**: OAuth 認証基盤の構築、公開インターネットへの公開、マルチユーザーの認可
- **非目的(MVP)**: `Mcp-Session-Id` の session map / transport map / resumable SSE / server→client notification
- **不変**: 既定は stdio。既存の起動経路・ツール挙動・テスト 165 本を変えない

## 環境変数

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `ORCA_MCP_TRANSPORT` | `stdio` | `stdio` / `http` |
| `ORCA_MCP_HTTP_HOST` | `127.0.0.1` | listen 先(`http` のときだけ参照) |
| `ORCA_MCP_HTTP_PORT` | `8765` | listen port(`http` のときだけ参照) |
| `ORCA_MCP_AUTH_TOKEN` | 未設定 | 設定したときだけ `Authorization: Bearer` を検証 |
| `ORCA_MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | `Host` ヘッダーの許可リスト(カンマ区切り) |
| `ORCA_MCP_ALLOWED_ORIGINS` | `localhost,127.0.0.1,[::1]` | `Origin` ヘッダーの許可リスト(カンマ区切り) |

- エンドポイントは `/mcp`
- 登録済みツールはトランスポート非依存(`createServer()` をそのまま使う)

## 中核の形(レビュー指摘 1・2 を反映)

**stateless 既定**。1 リクエスト 1 回の `McpServer` を factory で生成する。

```
stdio
  → serveStdio(() => createServer())

http
  → node:http server
  → Host gate → Origin gate → Bearer gate
  → toNodeHandler(createMcpHandler((ctx) => createServer()))
  → Response
```

- `McpServerFactory = (ctx: McpRequestContext) => McpServer`(SDK 型定義で確認済み)= リクエストごとに fresh server
- `Mcp-Session-Id` / session map / transport map は **作らない**
- 単一 transport を複数クライアントで共有しない(**クロスクライアント応答漏洩**の型そのものを最初から作らない)
- 2025 世代の legacy 経路は SDK 既定の `'stateless'` に任せる(GET / DELETE は `405` で返る)

**薄い Node 適応層**。自前の `IncomingMessage → Request` / `Response → ServerResponse` 変換は書かない。

- `@modelcontextprotocol/node` の `toNodeHandler(handler, { maxRequestBodySize })` を使う
  - 既定 4 MiB を超える body は `handler.fetch` を呼ばずに **413**
  - SSE の backpressure を honoring して書き出す(自前実装で最も壊しやすい部分)
- `Host` / `Origin` も node 形の guard(`hostHeaderValidation` / `originValidation`)が**自分で 403 を回答**する
  → gate は「通すか / すでに回答済みか」の真偽だけを見る

## 依存(新規)

| package | 版 | 根拠 |
| --- | --- | --- |
| `@modelcontextprotocol/node` | `^2.1.1` | peer が `@modelcontextprotocol/server: ^2.3.0`(本リポジトリは `^2.3.1`、適合) |

内包: `hono` / `@hono/node-server`(変換層)。自前変換を書かないこととの取り引きとして受け入れる。

## Bearer 認証

方針はレビューどおり(自前 401 を作らない)。

```ts
// src/server/auth.ts(概要)
class StaticTokenVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // 不一致 → OAuthError(OAuthErrorCode.InvalidToken) を投げる(401 + WWW-Authenticate に写像)
    // 一致 → { token, clientId, scopes, expiresAt } を返す
  }
}
```

- **`AuthInfo.expiresAt` は検証時刻 + 3600 秒**(起動時刻 + N 時間だと長時間起動で token が失効する)
- 比較は `timingSafeEqual`(長さが違えば比較しない)
- 401 / 403 / `WWW-Authenticate` は SDK が生成する(`requireBearerAuth` / `bearerAuthChallengeResponse`)

## bind と到達性(実測)

`127.0.0.1` に bind したソケットは**同一マシンからしか到達しない**ことを実測で確認した。

```
A) 127.0.0.1 に bind  →  loopback 接続: OK 200 / LAN IP 接続: FAIL(リモートサーバーに接続できません)
B) 0.0.0.0 に bind    →  LAN IP 接続: OK 200 / loopback 接続: OK 200
```

**推奨経路はトンネル**(サーバーはループバック専用のまま)。

```bash
ssh -L 8765:127.0.0.1:8765 <server>     # クライアント側の 127.0.0.1 に転送
```

- クライアントの `Host` は `127.0.0.1` のまま → **許可リスト追加なしで通る**
- WireGuard / Tailscale も同じ発想(トンネル IP を許可リストへ足す)

**`0.0.0.0` / 特定 NIC IP への direct bind は非推奨**(plain HTTP を LAN にさらす)。
使う場合は TLS proxy か VPN の内側でのみ運用する。

## 起動拒否の規則(レビュー指摘 3・4 を反映)

| bind 先 | トークン | 挙動 |
| --- | --- | --- |
| loopback | あり / なし | 起動する(許可リストは localhost 系のみ) |
| loopback 以外(`0.0.0.0` / NIC IP) | **なし** | **listen する前に起動を拒否**(`console.error` + 終了)。警告では足りない |
| loopback 以外 | あり | 起動する。許可リストは bind 先 + `ORCA_MCP_ALLOWED_HOSTS` を合成 |

- 許可リストに無い `Host` は **403**、`Origin` も **403**(SDK 実装で status を確認済み)
- Windows では LAN 公開に**受信ファイアウォールルール**が必要(README に書く)

## ファイル構成

```
src/server/config.ts   # env 解釈(純粋関数)+ 起動可否の判定(拒否理由を含む)
src/server/auth.ts     # StaticTokenVerifier(OAuthTokenVerifier 実装)
src/server/http.ts     # node:http server + gates + toNodeHandler(createMcpHandler(...)) + 起動 / 停止
src/index.ts           # isMainModule() で stdio / http を分岐(SIGINT / SIGTERM で close)
tests/transport-config.test.ts
tests/http-transport.test.ts   # port 0 で実 HTTP サーバーを起動して叩く
```

`http.ts` の責務は「サーバー生成 + gate 合成 + 起動 / 停止」に留め、**変換は書かない**。

## 起動と接続

```bash
# サーバー側(既定 = ローカル専用)
ORCA_MCP_TRANSPORT=http ORCA_MCP_AUTH_TOKEN=$(openssl rand -hex 32) node dist/index.js
```

```json
{ "mcpServers": { "orca": {
  "type": "http",
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer <token>" }
} } }
```

## テスト方針(レビュー指摘を反映)

| 文件 | 内容 |
| --- | --- |
| `transport-config.test.ts` | 既定値 / 無効値 / port 範囲 / host 正規化 / 警告生成 / **loopback 以外 + token 無しで起動拒否** / `ORCA_MCP_ALLOWED_HOSTS` / `ORCA_MCP_ALLOWED_ORIGINS` の解釈 |
| `http-transport.test.ts` | port 0 で実 HTTP サーバー → `tools/list` / `tools/call` が stdio と同一応答 / 401(token 欠落・不一致・Bearer 以外・scheme 大小文字) / **403(Host 不正・Origin 不正)** / **413(4 MiB 超過)** / **2 クライアント同時接続で応答が混ざらない** / **SIGINT / SIGTERM で close される** |
| 既存 165 本 | 不変(既定 stdio の挙動を変えないことの担保) |

**stateful 前提のテストは作らない**(`Mcp-Session-Id` 採番、session 破棄、session 単位 close 等)。

## README / AGENTS.md への反映(実装時)

- **README**: 「別 PC から使う」節(環境変数・接続例・`ssh -L` を第一選択・TLS proxy / VPN の話)と、
  plain HTTP を LAN に直接公開しないこと、Windows のファイアウォール、トークン管理の注意
- **AGENTS.md**: 決まりとして書き込む — 自前 401 を作らない / SDK の gate を使う / `expiresAt` は検証時刻 + 3600 /
  HTTP でも stdout はワイヤー専用 / 単一 transport を複数クライアントで共有しない

## 将来に回すもの

`server → client notification` / resumable SSE / 2025 世代の sessionful クライアントが**実際に必要に
なったときだけ** sessionful transport を足す。そのとき `Mcp-Session-Id` と session map を設計する。

## 実測で確認済みの事実(実装の前提)

- `@modelcontextprotocol/server` 2.3.1: `createMcpHandler` / `requireBearerAuth` / `verifyBearerToken` /
  `bearerAuthChallengeResponse` / `validateHostHeader` / `validateOriginHeader` /
  `localhostAllowedHostnames()` = `["localhost","127.0.0.1","[::1]"]` /
  `localhostAllowedOrigins()` = 同じ / `DEFAULT_MAX_REQUEST_BODY_SIZE` = `4194304`
- `hostHeaderValidationResponse` / `originValidationResponse` の status は **403**
- `CreateMcpHandlerOptions` の legacy 扱いは既定 `'stateless'`(GET / DELETE は `405`)
- `@modelcontextprotocol/node` 2.1.1: `toNodeHandler` / `toWebRequest` / `NodeStreamableHTTPServerTransport` /
  `hostHeaderValidation` / `originValidation` を公開、peer は `@modelcontextprotocol/server: ^2.3.0`
- `toNodeHandler` の `maxRequestBodySize` 既定 4 MiB(超過は `handler.fetch` を呼ばず 413)
- `OAuthTokenVerifier` は `AuthInfo.expiresAt` 未設定の token を拒否する(型定義のコメントで明文化)
