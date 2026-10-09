/**
 * 環境変数からトランスポート設定を組み立てる最下層(純粋関数)。
 * プロセス起動・listen はここでは一切行わない(テストで env を渡して検証できる形に保つ)。
 */

export type TransportKind = "stdio" | "http";

export const TRANSPORT_ENV = "ORCA_MCP_TRANSPORT";
export const HTTP_HOST_ENV = "ORCA_MCP_HTTP_HOST";
export const HTTP_PORT_ENV = "ORCA_MCP_HTTP_PORT";
export const AUTH_TOKEN_ENV = "ORCA_MCP_AUTH_TOKEN";
export const ALLOWED_HOSTS_ENV = "ORCA_MCP_ALLOWED_HOSTS";
export const ALLOWED_ORIGINS_ENV = "ORCA_MCP_ALLOWED_ORIGINS";

export const DEFAULT_TRANSPORT: TransportKind = "stdio";
export const DEFAULT_HTTP_HOST = "127.0.0.1";
/** listen port の既定。0 は「空きポートを割り当てる」(テストで使う)。 */
export const DEFAULT_HTTP_PORT = 8765;
export const MIN_HTTP_PORT = 0;
export const MAX_HTTP_PORT = 65535;

/** `Host` / `Origin` の既定許可リスト(SDK の localhost 系と揃える)。 */
export const DEFAULT_ALLOWED_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

export interface TransportConfig {
  readonly transport: TransportKind;
  readonly host: string;
  readonly port: number;
  /** `ORCA_MCP_AUTH_TOKEN` が設定されたときだけ非 null。 */
  readonly authToken: string | null;
  /** `Host` ヘッダーの許可リスト(hostname のみ、port 非依存)。 */
  readonly allowedHosts: readonly string[];
  /** `Origin` ヘッダーの許可リスト(hostname のみ)。 */
  readonly allowedOrigins: readonly string[];
}

export type TransportConfigErrorCode =
  | "transport_invalid"
  | "host_invalid"
  | "port_invalid"
  | "allowed_hosts_invalid";

/** 設定が組み立てられないことを表す(起動を続けられない)。 */
export class TransportConfigError extends Error {
  readonly code: TransportConfigErrorCode;

  constructor(code: TransportConfigErrorCode, message: string) {
    super(message);
    this.name = "TransportConfigError";
    this.code = code;
  }
}

/** 起動してはならない設定であることを表す(listen 前に断る)。 */
export type StartUpRefusal = { readonly code: "http_token_required"; readonly message: string };

function trimToNull(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * `server.listen()` に渡すアドレス表記へ正規化する(IPv6 の括弧は**取外す**)。
 * `listen(0, "[::1]")` は Linux の getaddrinfo で `ENOTFOUND` になる(実測: Windows の Node 24 は許す)。
 */
export function normalizeListenHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * `Host` / `Origin` の許可リストに使う hostname 表記へ正規化する(IPv6 は**括弧付き**)。
 * SDK の `validateHostHeader` は `Host` から `[::1]` を取り出すため、こちら側の表記に揃える。
 */
export function normalizeAllowedHostname(host: string): string {
  const value = normalizeListenHost(host);
  if (value.includes(":")) {
    return `[${value}]`;
  }
  return value;
}

/** `127.0.0.0/8`・`localhost`・`::1` をループバックとみなす(bind 用表記・許可リスト表記の両方を受ける)。 */
export function isLoopbackHost(host: string): boolean {
  const value = normalizeListenHost(host);
  if (value === "localhost" || value === "::1") {
    return true;
  }
  return value.startsWith("127.");
}

/** `0.0.0.0` / `::` は「全 NIC」。特定 NIC 指定より攻撃面が広い。 */
export function isUnspecifiedHost(host: string): boolean {
  const value = normalizeListenHost(host);
  return value === "0.0.0.0" || value === "::" || value === "*";
}

function parseHostList(raw: string | undefined, envName: string): string[] {
  const value = trimToNull(raw);
  if (value === null) {
    return [...DEFAULT_ALLOWED_HOSTNAMES];
  }
  const items = value
    .split(",")
    .map((part) => normalizeAllowedHostname(part))
    .filter((part) => part.length > 0);
  if (items.length === 0) {
    throw new TransportConfigError("allowed_hosts_invalid", `${envName} が空です`);
  }
  return [...new Set(items)];
}

/** env から設定を組み立てる(既定は stdio。既存の起動経路を変えない)。 */
export function resolveTransportConfig(env: NodeJS.ProcessEnv = process.env): TransportConfig {
  const rawTransport = trimToNull(env[TRANSPORT_ENV]);
  let transport: TransportKind;
  if (rawTransport === null) {
    transport = DEFAULT_TRANSPORT;
  } else {
    const lowered = rawTransport.toLowerCase();
    if (lowered !== "stdio" && lowered !== "http") {
      throw new TransportConfigError(
        "transport_invalid",
        `${TRANSPORT_ENV} は stdio / http のいずれか(受け取った値: ${rawTransport})`,
      );
    }
    transport = lowered;
  }

  const rawHostEnv = env[HTTP_HOST_ENV];
  const rawHost = trimToNull(rawHostEnv);
  let host = DEFAULT_HTTP_HOST;
  if (rawHostEnv !== undefined && rawHost === null) {
    // 設定したのに空、という入力は黙って既定に寄せない(意図しない bind を防ぐ)。
    throw new TransportConfigError("host_invalid", `${HTTP_HOST_ENV} が空です`);
  }
  if (rawHost !== null) {
    const normalized = normalizeListenHost(rawHost);
    if (normalized.length === 0 || /\s/.test(normalized)) {
      throw new TransportConfigError("host_invalid", `${HTTP_HOST_ENV} が不正です: ${rawHost}`);
    }
    host = normalized;
  }

  const rawPort = trimToNull(env[HTTP_PORT_ENV]);
  let port = DEFAULT_HTTP_PORT;
  if (rawPort !== null) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < MIN_HTTP_PORT || parsed > MAX_HTTP_PORT) {
      throw new TransportConfigError(
        "port_invalid",
        `${HTTP_PORT_ENV} は ${MIN_HTTP_PORT} から ${MAX_HTTP_PORT} の整数(受け取った値: ${rawPort})`,
      );
    }
    port = parsed;
  }

  const authToken = trimToNull(env[AUTH_TOKEN_ENV]);
  const allowedHosts = parseHostList(env[ALLOWED_HOSTS_ENV], ALLOWED_HOSTS_ENV);
  const allowedOrigins = parseHostList(env[ALLOWED_ORIGINS_ENV], ALLOWED_ORIGINS_ENV);

  return { transport, host, port, authToken, allowedHosts, allowedOrigins };
}

/**
 * bind 先に対して `Host` 許可リストに必ず含まれていなければならないもの。
 * 特定 NIC IP を指定したときは、その IP を叩くクライアントの `Host` を通さないと 403 になる。
 * 全 NIC(`0.0.0.0`)は到達に使う名前が運用側で決まるので、自動で足さない。
 */
export function requiredHostnames(config: TransportConfig): string[] {
  if (isLoopbackHost(config.host) || isUnspecifiedHost(config.host)) {
    return [];
  }
  return [normalizeAllowedHostname(config.host)];
}

/** 許可リストの不足を起動前に検出する(起動してから全リクエストが 403 になる状態を作らない)。 */
export function missingHostnames(config: TransportConfig): string[] {
  const allowed = new Set(config.allowedHosts.map((host) => normalizeAllowedHostname(host)));
  return requiredHostnames(config).filter((host) => !allowed.has(host));
}

/**
 * listen 前に起動を断る条件。
 * plain HTTP をループバック外へ開くのにトークンが無い構成は、警告では足りない。
 */
export function startUpRefusal(config: TransportConfig): StartUpRefusal | null {
  if (config.transport !== "http") {
    return null;
  }
  if (isLoopbackHost(config.host) || config.authToken !== null) {
    return null;
  }
  return {
    code: "http_token_required",
    message:
      `${TRANSPORT_ENV}=http で ${HTTP_HOST_ENV}=${config.host}(ループバック外)へ listen するのに ` +
      `${AUTH_TOKEN_ENV} が未設定です。plain HTTP を LAN へさらす構成は起動しません。` +
      `${AUTH_TOKEN_ENV} を設定するか、${HTTP_HOST_ENV} を 127.0.0.1 にして ` +
      "ssh -L のようなトンネルで中継してください。",
  };
}

/** 起動はするが運用者に伝えるべき注意(診断は stderr へ出す)。 */
export function transportWarnings(config: TransportConfig): string[] {
  if (config.transport !== "http") {
    return [];
  }
  const warnings: string[] = [];
  if (isUnspecifiedHost(config.host)) {
    warnings.push(
      `全 NIC(${config.host})に listen しています。到達に使うホスト名を ${ALLOWED_HOSTS_ENV} に` +
        "列挙してください(未指定の Host は 403 で拒否されます)。",
    );
  }
  const missing = missingHostnames(config);
  if (missing.length > 0) {
    warnings.push(
      `${ALLOWED_HOSTS_ENV} に bind 先が入っていません: ${missing.join(", ")} ` +
        `(その IP で叩くクライアントは 403 になります)。`,
    );
  }
  if (!isLoopbackHost(config.host)) {
    warnings.push(
      "plain HTTP をループバック外へ公開しています。ssh -L / TLS proxy / VPN の内側で運用してください。",
    );
  }
  return warnings;
}
