import { getSandbox, type Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface SandboxSecrets {
  env?: Record<string, string>;
  files?: Array<{ source: string; target: string }>;
}

type HeaderRules = Record<string, Record<string, string>>;

interface ExecRequestBody {
  sandboxId?: string;
  command?: string;
  timeoutSeconds?: number;
  cwd?: string;
  env?: Record<string, string>;
  secrets?: SandboxSecrets;
}

interface Env {
  Sandbox: DurableObjectNamespace<CloudflareSandbox>;
  BRIDGE_TOKEN?: string;
}

const proxySessions = new Map<string, HeaderRules>();

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function requireAuth(request: Request, env: Env): Response | undefined {
  const expected = env.BRIDGE_TOKEN?.trim();
  if (!expected) return undefined;

  const provided = request.headers.get("authorization");
  if (provided === `Bearer ${expected}`) return undefined;
  return unauthorized();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const authError = requireAuth(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method !== "POST" || url.pathname !== "/exec") {
      if (url.pathname.startsWith("/proxy/")) {
        return handleProxyRequest(request, url);
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    let body: ExecRequestBody;
    try {
      body = (await request.json()) as ExecRequestBody;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!body.sandboxId || !body.command) {
      return Response.json({ error: "sandboxId and command are required" }, { status: 400 });
    }
    if (body.env && Object.keys(body.env).length > 0) {
      return Response.json(
        {
          error:
            "env injection is not supported because sandbox commands can read environment variables",
        },
        { status: 400 },
      );
    }
    if (body.secrets?.files && body.secrets.files.length > 0) {
      return Response.json(
        { error: "secrets.files is not supported by this Cloudflare sandbox bridge" },
        { status: 400 },
      );
    }
    let proxySession: { token: string; env: Record<string, string> } | undefined;
    try {
      proxySession = createProxySession(request, body.secrets?.env);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json({ error: detail }, { status: 400 });
    }

    try {
      const sandbox = getSandbox(env.Sandbox, body.sandboxId, {
        normalizeId: true,
        sleepAfter: "5m",
      });
      const result = await sandbox.exec(body.command, {
        timeout:
          typeof body.timeoutSeconds === "number" && body.timeoutSeconds > 0
            ? body.timeoutSeconds * 1000
            : undefined,
        cwd: body.cwd || "/workspace",
        env: proxySession?.env,
      });

      return Response.json({
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exitCode,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json({ error: detail }, { status: 500 });
    } finally {
      if (proxySession) proxySessions.delete(proxySession.token);
    }
  },
};

function createProxySession(
  request: Request,
  env?: Record<string, string>,
): { token: string; env: Record<string, string> } | undefined {
  const rules = parseProxyHeaderRules(env);
  if (!rules) return undefined;

  const token = crypto.randomUUID();
  proxySessions.set(token, rules);
  const proxyUrl = new URL(`/proxy/${token}`, request.url).toString();
  return { token, env: { HTTP_PROXY: proxyUrl, http_proxy: proxyUrl } };
}

function parseProxyHeaderRules(env?: Record<string, string>): HeaderRules | undefined {
  const raw = env?.MIKAN_PROXY_INJECT_HEADERS;
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!isHeaderRules(parsed)) throw new Error("Invalid MIKAN_PROXY_INJECT_HEADERS JSON");
  return parsed;
}

async function handleProxyRequest(request: Request, url: URL): Promise<Response> {
  if (request.method === "CONNECT") {
    return new Response(
      "MIKAN_PROXY_INJECT_HEADERS supports HTTP proxy requests only; HTTPS CONNECT cannot be modified.\n",
      { status: 501 },
    );
  }

  const token = url.pathname.slice("/proxy/".length);
  const rules = proxySessions.get(token);
  if (!rules) return Response.json({ error: "proxy session not found" }, { status: 404 });

  const target = parseProxyTarget(request);
  if (!target) return new Response("proxy requires absolute-form request target", { status: 400 });

  const headers = new Headers(request.headers);
  for (const [key, value] of Object.entries(rules[target.host] ?? {})) {
    headers.set(key, value);
  }
  headers.delete("proxy-authorization");

  return fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

function parseProxyTarget(request: Request): URL | undefined {
  try {
    const raw = new URL(request.url).searchParams.get("url") || request.url;
    if (!raw.startsWith("http://") && !raw.startsWith("https://")) return undefined;
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function isHeaderRules(value: unknown): value is HeaderRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (headers) =>
      headers &&
      typeof headers === "object" &&
      !Array.isArray(headers) &&
      Object.values(headers).every((header) => typeof header === "string"),
  );
}
