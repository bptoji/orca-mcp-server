/**
 * Bearer 認証の小さな部品だけを持つ。
 * 401 / 403 / `WWW-Authenticate` は SDK が組み立てるので、ここでは作らない。
 */

import { timingSafeEqual } from "node:crypto";
import { OAuthError, OAuthErrorCode, requireBearerAuth } from "@modelcontextprotocol/server";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";

/** 静的トークンに付ける client id(認可基盤が無いことを正直に表す固定値)。 */
export const STATIC_TOKEN_CLIENT_ID = "orca-mcp-static-token";

/**
 * `AuthInfo.expiresAt` の有効期間(秒)。
 * SDK は `expiresAt` 未設定の token を拒否する。起動時刻から数えると長時間起動で
 * 自分自身の token が失効するので、**検証時刻 + この秒数**で計算する。
 */
export const STATIC_TOKEN_TTL_SECONDS = 3600;

/** 長さ違いで比較が分岐しないよう、先に長さを見て落とす(一致時のみ timingSafeEqual)。 */
export function tokensEqual(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  if (expectedBytes.length !== receivedBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, receivedBytes);
}

/**
 * 環境変数の静的トークンを SDK の verifier として使う形。
 * 不一致は `invalid_token` で投げる(401 + `WWW-Authenticate` に写像される)。
 */
export class StaticTokenVerifier implements OAuthTokenVerifier {
  readonly #token: string;
  readonly #ttlSeconds: number;

  constructor(token: string, ttlSeconds: number = STATIC_TOKEN_TTL_SECONDS) {
    if (token.trim().length === 0) {
      throw new Error("StaticTokenVerifier requires a non-empty token");
    }
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("StaticTokenVerifier requires a positive integer ttlSeconds");
    }
    this.#token = token;
    this.#ttlSeconds = ttlSeconds;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!tokensEqual(this.#token, token)) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid bearer token");
    }
    return {
      token,
      clientId: STATIC_TOKEN_CLIENT_ID,
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + this.#ttlSeconds,
    };
  }
}

/**
 * `Authorization: Bearer <token>` を要求する gate。
 * 戻り値は検証済み `AuthInfo`、またはそのまま返せる拒否 `Response`。
 */
export function bearerAuthGate(token: string): (request: Request) => Promise<AuthInfo | Response> {
  return requireBearerAuth({ verifier: new StaticTokenVerifier(token) });
}
