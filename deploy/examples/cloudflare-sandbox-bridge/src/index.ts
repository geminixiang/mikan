import { getSandbox, type Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface ExecRequestBody {
  sandboxId?: string;
  command?: string;
  timeoutSeconds?: number;
  cwd?: string;
  env?: Record<string, string>;
}

interface Env {
  Sandbox: DurableObjectNamespace<CloudflareSandbox>;
  BRIDGE_TOKEN?: string;
}

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
        env: body.env,
      });

      return Response.json({
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exitCode,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json({ error: detail }, { status: 500 });
    }
  },
};
