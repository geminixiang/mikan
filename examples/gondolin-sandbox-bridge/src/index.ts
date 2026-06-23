import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { VM, RealFSProvider, createHttpHooks } from "@earendil-works/gondolin";

interface SandboxSecrets {
  env?: Record<string, string>;
  files?: Array<{ source: string; target: string }>;
}

interface ExecRequestBody {
  sandboxId?: string;
  command?: string;
  timeoutSeconds?: number;
  cwd?: string;
  env?: Record<string, string>;
  secrets?: SandboxSecrets;
}

const PORT = Number(process.env.PORT || process.env.GONDOLIN_BRIDGE_PORT || 8788);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.GONDOLIN_SANDBOX_TOKEN;
const WORKSPACE = process.env.GONDOLIN_WORKSPACE || process.cwd();
const sessions = new Map<string, Promise<VM>>();

function unauthorized(response: ServerResponse): void {
  json(response, 401, { error: "unauthorized" });
}

function requireAuth(request: IncomingMessage, response: ServerResponse): boolean {
  if (!BRIDGE_TOKEN) return true;
  if (request.headers.authorization === `Bearer ${BRIDGE_TOKEN}`) return true;
  unauthorized(response);
  return false;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function ensureVm(sandboxId: string, secrets?: SandboxSecrets): Promise<VM> {
  const existing = sessions.get(sandboxId);
  if (existing) return existing;

  const created = VM.create({
    ...buildHttpPolicy(secrets?.env),
    vfs: {
      mounts: {
        "/workspace": new RealFSProvider(WORKSPACE),
      },
    },
  });
  sessions.set(sandboxId, created);
  return created;
}

function buildHttpPolicy(env?: Record<string, string>) {
  const rules = parseProxyRules(env);
  if (!rules) return {};

  const secretEntries: Record<string, { hosts: string[]; value: string }> = {};
  const allowedHosts = Object.keys(rules);
  let index = 0;
  for (const [host, headers] of Object.entries(rules)) {
    for (const value of Object.values(headers)) {
      const name = `MIKAN_PROXY_SECRET_${index++}`;
      secretEntries[name] = { hosts: [host], value };
    }
  }

  const { httpHooks, env: hookEnv } = createHttpHooks({
    allowedHosts,
    secrets: secretEntries,
  });
  return { httpHooks, env: hookEnv };
}

function parseProxyRules(
  env?: Record<string, string>,
): Record<string, Record<string, string>> | undefined {
  const raw = env?.MIKAN_PROXY_INJECT_HEADERS;
  if (!raw) return undefined;
  return JSON.parse(raw) as Record<string, Record<string, string>>;
}

async function handleExec(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: ExecRequestBody;
  try {
    body = await readJson<ExecRequestBody>(request);
  } catch {
    json(response, 400, { error: "invalid_json" });
    return;
  }

  if (!body.sandboxId || !body.command) {
    json(response, 400, { error: "sandboxId and command are required" });
    return;
  }

  if (body.env && Object.keys(body.env).length > 0) {
    json(response, 400, {
      error:
        "env injection is not supported because sandbox commands can read environment variables",
    });
    return;
  }
  if (body.secrets?.files && body.secrets.files.length > 0) {
    json(response, 400, { error: "secrets.files is not supported by this Gondolin bridge" });
    return;
  }

  try {
    const vm = await ensureVm(body.sandboxId, body.secrets);
    const result = await vm.exec(body.command, {
      cwd: body.cwd || "/workspace",
      timeout: body.timeoutSeconds ? body.timeoutSeconds * 1000 : undefined,
    });

    json(response, 200, {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    json(response, 500, { error: detail });
  }
}

createServer((request, response) => {
  if (!requireAuth(request, response)) return;
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && request.url === "/exec") {
    handleExec(request, response).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      json(response, 500, { error: detail });
    });
    return;
  }
  json(response, 404, { error: "not_found" });
}).listen(PORT, () => {
  console.log(`mikan Gondolin sandbox bridge listening on :${PORT}`);
  console.log(`workspace: ${WORKSPACE}`);
});
