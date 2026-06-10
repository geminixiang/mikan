import { getSandbox, type Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface ExecRequestBody {
  sandboxId?: string;
  command?: string;
  timeoutSeconds?: number;
  cwd?: string;
  /** Legacy clients only; newer mikan versions push env once via /env. */
  env?: Record<string, string>;
}

interface EnvRequestBody {
  sandboxId?: string;
  env?: Record<string, string>;
}

interface MkdirRequestBody {
  sandboxId?: string;
  path?: string;
}

interface WriteFileRequestBody {
  sandboxId?: string;
  path?: string;
  content?: string;
  /** Octal file mode, e.g. "600". Applied with chmod after the write. */
  mode?: string;
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

function bridgeSandbox(env: Env, sandboxId: string) {
  return getSandbox(env.Sandbox, sandboxId, {
    normalizeId: true,
    sleepAfter: "5m",
  });
}

async function readJson<T>(request: Request): Promise<T | undefined> {
  try {
    return (await request.json()) as T;
  } catch {
    return undefined;
  }
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

function internalError(error: unknown): Response {
  const detail = error instanceof Error ? error.message : String(error);
  return Response.json({ error: detail }, { status: 500 });
}

async function handleExec(request: Request, env: Env): Promise<Response> {
  const body = await readJson<ExecRequestBody>(request);
  if (!body) return badRequest("invalid_json");
  if (!body.sandboxId || !body.command) {
    return badRequest("sandboxId and command are required");
  }

  try {
    const sandbox = bridgeSandbox(env, body.sandboxId);
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
    return internalError(error);
  }
}

async function handleEnv(request: Request, env: Env): Promise<Response> {
  const body = await readJson<EnvRequestBody>(request);
  if (!body) return badRequest("invalid_json");
  if (!body.sandboxId || !body.env || typeof body.env !== "object") {
    return badRequest("sandboxId and env are required");
  }

  try {
    const sandbox = bridgeSandbox(env, body.sandboxId);
    await sandbox.setEnvVars(body.env);
    return Response.json({ ok: true });
  } catch (error) {
    return internalError(error);
  }
}

async function handleMkdir(request: Request, env: Env): Promise<Response> {
  const body = await readJson<MkdirRequestBody>(request);
  if (!body) return badRequest("invalid_json");
  if (!body.sandboxId || !body.path) {
    return badRequest("sandboxId and path are required");
  }

  try {
    const sandbox = bridgeSandbox(env, body.sandboxId);
    await sandbox.mkdir(body.path, { recursive: true });
    return Response.json({ ok: true });
  } catch (error) {
    return internalError(error);
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function handleWriteFile(request: Request, env: Env): Promise<Response> {
  const body = await readJson<WriteFileRequestBody>(request);
  if (!body) return badRequest("invalid_json");
  if (!body.sandboxId || !body.path || typeof body.content !== "string") {
    return badRequest("sandboxId, path, and content are required");
  }
  if (body.mode !== undefined && !/^[0-7]{3,4}$/.test(body.mode)) {
    return badRequest("mode must be an octal string like 600");
  }

  try {
    const sandbox = bridgeSandbox(env, body.sandboxId);
    await sandbox.writeFile(body.path, body.content);
    if (body.mode) {
      await sandbox.exec(`chmod ${body.mode} ${shellEscape(body.path)}`);
    }
    return Response.json({ ok: true });
  } catch (error) {
    return internalError(error);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const authError = requireAuth(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "POST") {
      switch (url.pathname) {
        case "/exec":
          return handleExec(request, env);
        case "/env":
          return handleEnv(request, env);
        case "/mkdir":
          return handleMkdir(request, env);
        case "/write-file":
          return handleWriteFile(request, env);
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
