import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import {
  DEFAULT_HTTP_IDLE_TIMEOUT_MS,
  configureHttpDispatcher,
  parseHttpIdleTimeoutMs,
} from "../harness/http.js";

describe("parseHttpIdleTimeoutMs", () => {
  test("accepts non-negative numbers, flooring fractions", () => {
    expect(parseHttpIdleTimeoutMs(0)).toBe(0);
    expect(parseHttpIdleTimeoutMs(30_000)).toBe(30_000);
    expect(parseHttpIdleTimeoutMs(1500.9)).toBe(1500);
  });

  test("accepts numeric strings and the disabled keyword", () => {
    expect(parseHttpIdleTimeoutMs("60000")).toBe(60_000);
    expect(parseHttpIdleTimeoutMs(" disabled ")).toBe(0);
    expect(parseHttpIdleTimeoutMs("Disabled")).toBe(0);
  });

  test("rejects invalid values", () => {
    expect(parseHttpIdleTimeoutMs("")).toBeUndefined();
    expect(parseHttpIdleTimeoutMs("soon")).toBeUndefined();
    expect(parseHttpIdleTimeoutMs(-1)).toBeUndefined();
    expect(parseHttpIdleTimeoutMs(Number.NaN)).toBeUndefined();
    expect(parseHttpIdleTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseHttpIdleTimeoutMs(null)).toBeUndefined();
    expect(parseHttpIdleTimeoutMs(undefined)).toBeUndefined();
  });
});

const fetchOverride: typeof globalThis.fetch = () => Promise.reject(new Error("stub"));

describe("configureHttpDispatcher", () => {
  test("installs an EnvHttpProxyAgent as the global dispatcher", () => {
    configureHttpDispatcher(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  test("swaps global fetch to undici's and keeps it on reconfigure", () => {
    configureHttpDispatcher();
    const installedFetch = globalThis.fetch;
    configureHttpDispatcher(60_000);
    expect(globalThis.fetch).toBe(installedFetch);
  });

  test("preserves a deliberate fetch override", () => {
    configureHttpDispatcher();
    const installedFetch = globalThis.fetch;
    globalThis.fetch = fetchOverride;
    try {
      configureHttpDispatcher();
      expect(globalThis.fetch).toBe(fetchOverride);
    } finally {
      globalThis.fetch = installedFetch;
    }
  });

  test("throws on an unparseable timeout", () => {
    expect(() => configureHttpDispatcher(-5)).toThrow(/Invalid HTTP idle timeout/);
  });
});

describe("configureHttpDispatcher proxy behavior", () => {
  const envKeys = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ] as const;
  let savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>>;
  let servers: Server[];

  function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ server: Server; port: number }> {
    const server = createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("expected a TCP address");
        }
        resolve({ server, port: address.port });
      });
    });
  }

  function startForwardingProxy(onForward: () => void) {
    return startServer((req, res) => {
      onForward();
      const target = req.url ? new URL(req.url) : undefined;
      if (!target) {
        res.writeHead(400).end();
        return;
      }
      const forward = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname || "/",
          method: req.method,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      req.pipe(forward);
    });
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    servers = [];
  });

  afterEach(async () => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    configureHttpDispatcher();
  });

  test("routes a request through HTTP_PROXY when the target is not excluded", async () => {
    const target = await startServer((_req, res) => {
      res.end("target-ok");
    });
    let proxyHits = 0;
    const proxy = await startForwardingProxy(() => {
      proxyHits += 1;
    });

    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    configureHttpDispatcher();

    const response = await fetch(`http://127.0.0.1:${target.port}/`);
    expect(await response.text()).toBe("target-ok");
    expect(proxyHits).toBe(1);
  });

  test("bypasses HTTP_PROXY for a root NO_PROXY domain and its subdomain form", async () => {
    const target = await startServer((_req, res) => {
      res.end("target-ok");
    });
    let proxyHits = 0;
    const proxy = await startForwardingProxy(() => {
      proxyHits += 1;
    });

    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.NO_PROXY = "127.0.0.1";
    configureHttpDispatcher();

    const response = await fetch(`http://127.0.0.1:${target.port}/`);
    expect(await response.text()).toBe("target-ok");
    expect(proxyHits).toBe(0);
  });

  test("does not bypass the proxy for an unrelated NO_PROXY domain", async () => {
    const target = await startServer((_req, res) => {
      res.end("target-ok");
    });
    let proxyHits = 0;
    const proxy = await startForwardingProxy(() => {
      proxyHits += 1;
    });

    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.NO_PROXY = "example.com";
    configureHttpDispatcher();

    const response = await fetch(`http://127.0.0.1:${target.port}/`);
    expect(await response.text()).toBe("target-ok");
    expect(proxyHits).toBe(1);
  });
});
