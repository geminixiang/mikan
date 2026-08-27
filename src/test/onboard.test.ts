import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderEnvFile, runOnboardWizard } from "../cli/onboard.js";
import type { OnboardIo } from "../cli/types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-onboard-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** IO that replays a fixed list of answers (secret or not) in order. */
function scriptedIo(answers: string[]): OnboardIo & { transcript: string[] } {
  const queue = [...answers];
  const transcript: string[] = [];
  const next = async (query: string) => {
    transcript.push(query);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`Ran out of answers at: ${query}`);
    return answer;
  };
  return {
    ask: next,
    askSecret: next,
    print: (line) => transcript.push(line),
    close: () => {},
    transcript,
  };
}

describe("renderEnvFile", () => {
  test("appends new vars to an empty file", () => {
    expect(renderEnvFile(undefined, { A: "1", B: "2" })).toBe("A=1\nB=2\n");
  });

  test("updates existing keys in place and keeps unrelated lines", () => {
    const existing = "# comment\nA=old\nKEEP=x\n";
    expect(renderEnvFile(existing, { A: "new", C: "3" })).toBe("# comment\nA=new\nKEEP=x\nC=3\n");
  });
});

describe("runOnboardWizard", () => {
  test("slack + anthropic + host writes settings and env file", async () => {
    const envFile = join(dir, "mikan.env");
    const io = scriptedIo([
      "1", // platform: Slack
      "xapp-123", // SLACK_APP_TOKEN
      "xoxb-456", // SLACK_BOT_TOKEN
      "1", // provider: Anthropic
      "sk-ant-789", // ANTHROPIC_API_KEY
      "", // model (default)
      "1", // sandbox: host
    ]);
    const code = await runOnboardWizard(dir, io, { envFilePath: envFile });
    expect(code).toBe(0);

    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    expect(settings.llm.provider).toBe("anthropic");
    expect(settings.llm.model).toBe("claude-sonnet-4-6");
    expect(settings.llm.autoReply).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });

    const envContent = readFileSync(envFile, "utf-8");
    expect(envContent).toContain("SLACK_APP_TOKEN=xapp-123");
    expect(envContent).toContain("SLACK_BOT_TOKEN=xoxb-456");
    expect(envContent).toContain("ANTHROPIC_API_KEY=sk-ant-789");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  test("custom endpoint writes models.json and points settings at it", async () => {
    const envFile = join(dir, "mikan.env");
    const modelsFile = join(dir, "models.json");
    const io = scriptedIo([
      "2", // platform: Telegram
      "tg-token", // TELEGRAM_BOT_TOKEN
      "3", // provider: custom
      "agent-model", // provider name
      "http://10.0.0.1:8080/v1", // base url
      "gw-key", // api key
      "chatgpt, gpt-5.6-sol", // model ids
      "2", // sandbox: image
      "", // image (default)
    ]);
    const code = await runOnboardWizard(dir, io, {
      envFilePath: envFile,
      modelsJsonPath: modelsFile,
    });
    expect(code).toBe(0);

    const models = JSON.parse(readFileSync(modelsFile, "utf-8"));
    expect(models.providers["agent-model"]).toMatchObject({
      api: "openai-completions",
      baseUrl: "http://10.0.0.1:8080/v1",
      apiKey: "gw-key",
      models: [{ id: "chatgpt" }, { id: "gpt-5.6-sol" }],
    });

    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    expect(settings.llm.provider).toBe("agent-model");
    expect(settings.llm.model).toBe("chatgpt");
    expect(settings.llm.autoReply).toEqual({ provider: "agent-model", model: "chatgpt" });

    const nextSteps = io.transcript.join("\n");
    expect(nextSteps).toContain("--sandbox image:ghcr.io/geminixiang/mikan-sandbox:latest");
  });

  test("github adapter asks required vars plus the private-key path", async () => {
    const envFile = join(dir, "mikan.env");
    const io = scriptedIo([
      "4", // platform: GitHub
      "12345", // GITHUB_APP_ID
      "678", // GITHUB_INSTALLATION_ID
      "/etc/mikan/app.pem", // GITHUB_APP_PRIVATE_KEY_PATH (anyOf)
      "2", // provider: OpenAI
      "sk-oai", // OPENAI_API_KEY
      "", // model (default)
      "1", // sandbox: host
    ]);
    const code = await runOnboardWizard(dir, io, { envFilePath: envFile });
    expect(code).toBe(0);
    const envContent = readFileSync(envFile, "utf-8");
    expect(envContent).toContain("GITHUB_APP_ID=12345");
    expect(envContent).toContain("GITHUB_APP_PRIVATE_KEY_PATH=/etc/mikan/app.pem");
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")).llm.provider).toBe(
      "openai",
    );
  });

  test("re-prompts on invalid choice and empty required answers", async () => {
    const envFile = join(dir, "mikan.env");
    const io = scriptedIo([
      "9", // invalid platform
      "3", // Discord
      "", // empty token → re-ask
      "dc-token",
      "1", // Anthropic
      "sk-ant",
      "",
      "1", // host
    ]);
    expect(await runOnboardWizard(dir, io, { envFilePath: envFile })).toBe(0);
    expect(readFileSync(envFile, "utf-8")).toContain("DISCORD_BOT_TOKEN=dc-token");
  });

  test("refuses to overwrite existing settings.json", async () => {
    writeFileSync(join(dir, "settings.json"), "{}");
    const io = scriptedIo([]);
    expect(await runOnboardWizard(dir, io, { envFilePath: join(dir, "mikan.env") })).toBe(1);
  });

  test("preserves unrelated vars in an existing env file", async () => {
    const envFile = join(dir, "mikan.env");
    writeFileSync(envFile, "SENTRY_DSN=https://x@sentry.io/1\nSLACK_BOT_TOKEN=stale\n");
    const io = scriptedIo(["1", "xapp-new", "xoxb-new", "1", "sk-ant", "", "1"]);
    expect(await runOnboardWizard(dir, io, { envFilePath: envFile })).toBe(0);
    const envContent = readFileSync(envFile, "utf-8");
    expect(envContent).toContain("SENTRY_DSN=https://x@sentry.io/1");
    expect(envContent).toContain("SLACK_BOT_TOKEN=xoxb-new");
    expect(envContent).not.toContain("stale");
  });
});
