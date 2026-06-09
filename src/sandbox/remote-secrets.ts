import type { SandboxSecrets } from "./types.js";

const PROXY_SECRET_ENV_KEY = "MIKAN_PROXY_INJECT_HEADERS";

export function buildRemoteSandboxSecrets(secrets?: SandboxSecrets): SandboxSecrets | undefined {
  const proxyRules = secrets?.env?.[PROXY_SECRET_ENV_KEY];
  if (!proxyRules) return undefined;
  return { env: { [PROXY_SECRET_ENV_KEY]: proxyRules } };
}
