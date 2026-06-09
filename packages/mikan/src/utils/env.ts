export function readEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (raw) return raw;

  const prefixed = process.env[`MIKAN_${name}`]?.trim();
  return prefixed || undefined;
}

export function setEnvAliases(name: string, value: string): void {
  process.env[name] = value;
  process.env[`MIKAN_${name}`] = value;
}
