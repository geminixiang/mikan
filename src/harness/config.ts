import { homedir } from "os";
import { join, resolve } from "path";
import { readEnv } from "../utils/env.js";

const CONFIG_DIR_NAME = ".mikan";

export function getMikanDir(): string {
  const raw = readEnv("STATE_DIR");
  return raw ? resolve(raw) : join(homedir(), CONFIG_DIR_NAME);
}

export function getAuthPath(): string {
  return join(getMikanDir(), "auth.json");
}

export function getModelsPath(): string {
  return join(getMikanDir(), "models.json");
}

export function getSettingsPath(): string {
  return join(getMikanDir(), "settings.json");
}

export function getProjectSkillsDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "skills");
}
