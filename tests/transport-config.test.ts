import { describe, expect, it } from "vitest";
import {
  ALLOWED_HOSTS_ENV,
  ALLOWED_ORIGINS_ENV,
  AUTH_TOKEN_ENV,
  DEFAULT_ALLOWED_HOSTNAMES,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_TRANSPORT,
  HTTP_HOST_ENV,
  HTTP_PORT_ENV,
  TRANSPORT_ENV,
  TransportConfigError,
  isLoopbackHost,
  isUnspecifiedHost,
  missingHostnames,
  normalizeAllowedHostname,
  normalizeListenHost,
  requiredHostnames,
  resolveTransportConfig,
  startUpRefusal,
  transportWarnings,
} from "../src/server/config.js";

describe("既定は stdio(既存の起動経路を変えない)", () => {
  it("空 env なら stdio / 127.0.0.1 / 8765 / トークン無し", () => {
    const config = resolveTransportConfig({});
    expect(config.transport).toBe(DEFAULT_TRANSPORT);
    expect(config.transport).toBe("stdio");
    expect(config.host).toBe(DEFAULT_HTTP_HOST);
    expect(config.port).toBe(DEFAULT_HTTP_PORT);
    expect(config.authToken).toBeNull();
    expect(config.allowedHosts).toEqual([...DEFAULT_ALLOWED_HOSTNAMES]);
    expect(config.allowedOrigins).toEqual([...DEFAULT_ALLOWED_HOSTNAMES]);
  });

  it("stdio 指定なら HTTP の設定値は無視する", () => {
    const config = resolveTransportConfig({
      [TRANSPORT_ENV]: "stdio",
      [HTTP_PORT_ENV]: "1",
      [AUTH_TOKEN_ENV]: "secret",
    });
    expect(config.transport).toBe("stdio");
    expect(startUpRefusal(config)).toBeNull();
    expect(transportWarnings(config)).toEqual([]);
  });

  it("http 指定を受け付ける(大小文字を問わない)", () => {
    expect(resolveTransportConfig({ [TRANSPORT_ENV]: "http" }).transport).toBe("http");
    expect(resolveTransportConfig({ [TRANSPORT_ENV]: "HTTP" }).transport).toBe("http");
  });

  it("無効なトランスポート名は transport_invalid", () => {
    const error = captureConfigError({ [TRANSPORT_ENV]: "sse" });
    expect(error).toBeInstanceOf(TransportConfigError);
    expect(error?.code).toBe("transport_invalid");
  });
});

describe("host / port の解釈", () => {
  it("host を正規化する(bind 用は括弧なし、許可リスト用は括弧付き)", () => {
    expect(normalizeListenHost("LocalHost")).toBe("localhost");
    expect(normalizeListenHost("::1")).toBe("::1");
    expect(normalizeListenHost("[::1]")).toBe("::1");
    expect(normalizeListenHost("192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeAllowedHostname("::1")).toBe("[::1]");
    expect(normalizeAllowedHostname("[::1]")).toBe("[::1]");
    expect(normalizeAllowedHostname("127.0.0.1")).toBe("127.0.0.1");
  });

  it("IPv6 loopback は bind 用に括弧を付けない(listen は ::1 を要求する)", () => {
    expect(resolveTransportConfig({ [HTTP_HOST_ENV]: "::1" }).host).toBe("::1");
    expect(resolveTransportConfig({ [HTTP_HOST_ENV]: "[::1]" }).host).toBe("::1");
    // 許可リスト側は括弧付き(`Host: [::1]` と突き合わせる表記)。
    expect(requiredHostnames(resolveTransportConfig({ [HTTP_HOST_ENV]: "::1" }))).toEqual([]);
  });

  it("port は 0 を受け付ける(テストで空きポートを割り当てる)", () => {
    expect(resolveTransportConfig({ [HTTP_PORT_ENV]: "0" }).port).toBe(0);
  });

  it("port の範囲外と非整数は port_invalid", () => {
    expect(captureConfigError({ [HTTP_PORT_ENV]: "70000" })?.code).toBe("port_invalid");
    expect(captureConfigError({ [HTTP_PORT_ENV]: "-1" })?.code).toBe("port_invalid");
    expect(captureConfigError({ [HTTP_PORT_ENV]: "87.5" })?.code).toBe("port_invalid");
    expect(captureConfigError({ [HTTP_PORT_ENV]: "abc" })?.code).toBe("port_invalid");
  });

  it("空白だけの host は host_invalid", () => {
    expect(captureConfigError({ [HTTP_HOST_ENV]: "   " })?.code).toBe("host_invalid");
  });

  it("ループバックと全 NIC を見分ける", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.53")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
    expect(isUnspecifiedHost("0.0.0.0")).toBe(true);
    expect(isUnspecifiedHost("::")).toBe(true);
    expect(isUnspecifiedHost("127.0.0.1")).toBe(false);
  });
});

describe("許可リストの解釈", () => {
  it("許可リスト表記に揃えて重複を落とす", () => {
    const config = resolveTransportConfig({
      [ALLOWED_HOSTS_ENV]: " LocalHost , 127.0.0.1 , localhost , 192.168.1.20 ",
      [ALLOWED_ORIGINS_ENV]: "192.168.1.20",
    });
    expect(config.allowedHosts).toEqual(["localhost", "127.0.0.1", "192.168.1.20"]);
    expect(config.allowedOrigins).toEqual(["192.168.1.20"]);
  });

  it("許可リストの IPv6 は括弧付き", () => {
    const config = resolveTransportConfig({ [ALLOWED_HOSTS_ENV]: "::1,example.local" });
    expect(config.allowedHosts).toEqual(["[::1]", "example.local"]);
  });

  it("空の許可リストは allowed_hosts_invalid", () => {
    expect(captureConfigError({ [ALLOWED_HOSTS_ENV]: " , , " })?.code).toBe("allowed_hosts_invalid");
  });
});

describe("bind 先が要求する Host", () => {
  it("ループバック bind は追加要求なし", () => {
    const config = resolveTransportConfig({});
    expect(requiredHostnames(config)).toEqual([]);
    expect(missingHostnames(config)).toEqual([]);
  });

  it("特定 NIC IP の bind はその IP が許可リストに要る", () => {
    const config = resolveTransportConfig({ [HTTP_HOST_ENV]: "192.168.1.20" });
    expect(requiredHostnames(config)).toEqual(["192.168.1.20"]);
    expect(missingHostnames(config)).toEqual(["192.168.1.20"]);
    const filled = resolveTransportConfig({
      [HTTP_HOST_ENV]: "192.168.1.20",
      [ALLOWED_HOSTS_ENV]: "192.168.1.20",
    });
    expect(missingHostnames(filled)).toEqual([]);
  });

  it("全 NIC bind は自動で足さない(運用側が列挙する)", () => {
    const config = resolveTransportConfig({ [TRANSPORT_ENV]: "http", [HTTP_HOST_ENV]: "0.0.0.0" });
    expect(requiredHostnames(config)).toEqual([]);
    expect(transportWarnings(config).some((line) => line.includes(ALLOWED_HOSTS_ENV))).toBe(true);
  });
});

describe("起動拒否(loopback 外 + トークン無し)", () => {
  it("http + 127.0.0.1 はトークン無しで起動してよい", () => {
    const config = resolveTransportConfig({ [TRANSPORT_ENV]: "http" });
    expect(startUpRefusal(config)).toBeNull();
    expect(transportWarnings(config)).toEqual([]);
  });

  it("http + ループバック外 + トークン無しは起動を拒否する", () => {
    for (const host of ["0.0.0.0", "192.168.1.20"]) {
      const config = resolveTransportConfig({ [TRANSPORT_ENV]: "http", [HTTP_HOST_ENV]: host });
      const refusal = startUpRefusal(config);
      expect(refusal).not.toBeNull();
      expect(refusal?.code).toBe("http_token_required");
      expect(refusal?.message).toContain(AUTH_TOKEN_ENV);
    }
  });

  it("トークンを設定すればループバック外も起動する(警告は出る)", () => {
    const config = resolveTransportConfig({
      [TRANSPORT_ENV]: "http",
      [HTTP_HOST_ENV]: "192.168.1.20",
      [AUTH_TOKEN_ENV]: "secret-token",
      [ALLOWED_HOSTS_ENV]: "192.168.1.20",
    });
    expect(startUpRefusal(config)).toBeNull();
    const warnings = transportWarnings(config);
    expect(warnings.some((line) => line.includes("plain HTTP"))).toBe(true);
    expect(warnings.some((line) => line.includes("192.168.1.20"))).toBe(false);
  });

  it("許可リストに bind 先が無いときは起動はするが警告する", () => {
    const config = resolveTransportConfig({
      [TRANSPORT_ENV]: "http",
      [HTTP_HOST_ENV]: "192.168.1.20",
      [AUTH_TOKEN_ENV]: "secret-token",
    });
    expect(startUpRefusal(config)).toBeNull();
    expect(
      transportWarnings(config).some((line) => line.includes("192.168.1.20")),
    ).toBe(true);
  });
});

function captureConfigError(env: Record<string, string>): TransportConfigError | null {
  try {
    resolveTransportConfig(env);
    return null;
  } catch (error) {
    return error instanceof TransportConfigError ? error : null;
  }
}
