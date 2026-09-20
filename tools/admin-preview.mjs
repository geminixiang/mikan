#!/usr/bin/env node
/**
 * Local admin-portal preview harness.
 *
 * Boots the real `handleAdminRequest` router against a throwaway workspace
 * seeded with realistic offices, sessions, skills, events and settings, so the
 * /admin UI can be exercised in a browser without any platform credentials.
 *
 *   node tools/admin-preview.mjs [port]
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const PORT = Number(process.argv[2] ?? 5199);
const ROOT = "/tmp/mikan-preview";
const WS = join(ROOT, "workspace");
const STATE = join(ROOT, "state");

process.env.MIKAN_STATE_DIR = STATE;

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(WS, { recursive: true, mode: 0o700 });
mkdirSync(STATE, { recursive: true, mode: 0o700 });

const { createWorkspace, createOfficeAddress } = await import("../dist/office/index.js");
const { handleAdminRequest, InMemoryAdminTokenStore } =
  await import("../dist/adapters/web/admin/portal.js");
const { OfficeEventStore } = await import("../dist/events/index.js");
const { SessionStore } = await import("../dist/sessions/session-store.js");

const workspace = createWorkspace({ root: WS, stateDir: STATE });
const eventStore = (office) => new OfficeEventStore(office);
const { InMemoryLinkTokenStore, createLoginRequestHandler } =
  await import("../dist/adapters/web/login/portal.js");
const { InMemorySessionViewTokenStore, handleSessionViewRequest } =
  await import("../dist/adapters/web/session-view/portal.js");

// ── workspace-level files ────────────────────────────────────────────────────
writeFileSync(
  join(WS, "MEMORY.md"),
  `# Memory\n\n- User prefers concise replies\n- Deploys happen on Fridays\n`,
);
writeFileSync(join(WS, "AGENTS.md"), `# AGENTS.md\n\nBe useful.\n`);

const globalSkills = {
  "hooks-setup": "Configure Memoh hooks in .memoh/hooks.json.",
  "skill-creator": "Create or update workspace skills under /data/skills.",
};
for (const [name, desc] of Object.entries(globalSkills)) {
  mkdirSync(join(WS, "skills", name), { recursive: true });
  writeFileSync(
    join(WS, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n${desc}\n`,
  );
}

// ── offices ──────────────────────────────────────────────────────────────────
/** @type {{platform:string,conversationId:string,title:string}[]} */
const offices = [
  { platform: "telegram", conversationId: "1001", title: "Alice" },
  { platform: "telegram", conversationId: "100200", title: "Dev Group" },
  { platform: "slack", conversationId: "C0ABCDE", title: "eng-standup" },
  { platform: "discord", conversationId: "777888", title: "Taku" },
  { platform: "github", conversationId: "geminixiang-mikan", title: "mikan repo" },
];

// AgentMessage carries `content` blocks, not a `text` field.
const say = (role, text) => ({ role, content: [{ type: "text", text }] });
const CONVERSATIONS = [
  say("user", "Can you summarise the deploy notes from yesterday?"),
  say(
    "assistant",
    "Yesterday's deploy shipped two fixes: the session-store lock retry and the office registry journal. Rollout was clean, no rollbacks.",
  ),
  say("user", "Great. Add a follow-up to check the migration status tomorrow."),
  say("assistant", "Added. I'll remind you tomorrow morning before the standup."),
];

let sessionIndex = 0;
for (const spec of offices) {
  const office = workspace.office(createOfficeAddress(spec.platform, spec.conversationId));
  office.ensure();
  mkdirSync(office.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(office.sessionsDir, { recursive: true, mode: 0o700 });
  mkdirSync(office.attachmentsDir, { recursive: true, mode: 0o700 });

  // per-conversation settings
  writeFileSync(
    join(office.stateDir, "settings.json"),
    JSON.stringify({ llm: { thinkingLevel: "medium" } }, null, 2),
  );

  // conversation-level skills
  mkdirSync(join(office.skillsDir, "daily-standup"), { recursive: true });
  writeFileSync(
    join(office.skillsDir, "daily-standup", "SKILL.md"),
    `---\nname: daily-standup\ndescription: Summarise yesterday's deploys for ${spec.title}.\n---\n\n# daily-standup\n`,
  );

  // one session with a realistic transcript
  const session = await SessionStore.create(
    join(office.sessionsDir, `s${sessionIndex}.jsonl`),
    WS,
    {
      model: "claude-sonnet-4-6",
    },
  );
  for (const msg of CONVERSATIONS) {
    await session.appendMessage({
      ...msg,
      timestamp: new Date(Date.now() - 3600_000).toISOString(),
    });
  }
  if (sessionIndex === 0) {
    const s2 = await SessionStore.create(join(office.sessionsDir, `s-recap.jsonl`), WS, {
      model: "claude-sonnet-4-6",
    });
    await s2.appendMessage(say("user", "Recap the week."));
    await s2.appendMessage(say("assistant", "Three PRs merged, one release cut."));
  }

  // events
  await eventStore(office).create(`preview-${sessionIndex}.json`, {
    type: "one-shot",
    platform: spec.platform,
    conversationId: spec.conversationId,
    userId: spec.conversationId,
    text: `Message handled for ${spec.title}`,
    at: new Date(Date.now() + 86_400_000).toISOString(),
  });

  // conversation scratch workspace (the only browsable subtree in the admin UI)
  const scratch = join(office.dir, "scratch");
  mkdirSync(join(scratch, "notes"), { recursive: true });
  writeFileSync(
    join(scratch, "README.md"),
    `# ${spec.title} scratch\n\nWorking notes for this conversation.\n`,
  );
  writeFileSync(
    join(scratch, "notes", "2026-09-18-deploy.md"),
    `# Deploy notes\n\n- session-store lock retry\n- office registry journal\n`,
  );
  writeFileSync(
    join(scratch, "notes", "migration-status.md"),
    `# Migration status\n\nPending review.\n`,
  );

  sessionIndex += 1;
}

// ── global settings ──────────────────────────────────────────────────────────
writeFileSync(
  join(STATE, "settings.json"),
  JSON.stringify(
    {
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "medium" },
      slack: { replyMode: "thread" },
      sandbox: {
        cpus: "2",
        memory: "4g",
        boost: { cpus: "4", memory: "8g" },
        defaultSharedVault: "shared",
      },
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", WS],
        },
        linear: { url: "https://mcp.linear.app/sse" },
        legacy: { command: "uvx", args: ["legacy-mcp"], disabled: true },
      },
    },
    null,
    2,
  ),
);

// ── admin token + server ─────────────────────────────────────────────────────
const adminTokenStore = new InMemoryAdminTokenStore();
const token = adminTokenStore.create({
  platform: "telegram",
  platformUserId: "1001",
  conversationId: "1001",
});

const services = {
  adminTokenStore,
  linkTokenStore: { take: () => undefined },
  workspace,
  eventStore,
  vaultManager: {},
  runtime: undefined,
  botsByPlatform: new Map(),
  portalBaseUrl: `http://127.0.0.1:${PORT}`,
};

const TOKEN_VALUE = typeof token === "string" ? token : token.token;

// ── vault (/link) and session view (/session) share the same portal shell, so
// they are served here too in order to catch regressions in shared styles.
const linkTokenStore = new InMemoryLinkTokenStore();
const linkToken = linkTokenStore.create("telegram", "1001", "1001", "vault-1001", "anthropic");
const handleLoginRequest = createLoginRequestHandler(
  linkTokenStore,
  previewVaultManager(),
  () => {},
);

const sessionViewTokenStore = new InMemorySessionViewTokenStore();
const previewSessionFile = join(
  workspace.office(createOfficeAddress("telegram", "1001")).sessionsDir,
  "s0.jsonl",
);
const sessionToken = sessionViewTokenStore.create({
  platform: "telegram",
  platformUserId: "1001",
  conversationId: "1001",
  sessionKey: "s0.jsonl",
  sessionFile: previewSessionFile,
});

/** Minimal in-memory vault manager stub for the credential page. */
function previewVaultManager() {
  return {
    /** The credential page only reads `env` and `mounts`. */
    resolve: (id) =>
      id === "vault-1001"
        ? {
            id,
            env: { ANTHROPIC_API_KEY: "sk-ant-preview", GITHUB_TOKEN: "ghp_preview" },
            mounts: [{ target: "/workspace/.secrets" }],
          }
        : null,
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  Promise.resolve()
    .then(async () => {
      if (await handleAdminRequest(req, res, url, services)) return;
      if (await handleLoginRequest(req, res, url)) return;
      if (await handleSessionViewRequest(req, res, url, sessionViewTokenStore)) return;
      res.statusCode = 404;
      res.end("not found");
    })
    .catch((err) => {
      res.statusCode = 500;
      res.end(String(err?.stack ?? err));
    });
});

writeFileSync(join(ROOT, "token.txt"), TOKEN_VALUE);

const urls = {
  admin: `http://127.0.0.1:${PORT}/admin?token=${TOKEN_VALUE}`,
  vault: `http://127.0.0.1:${PORT}/link?token=${linkToken.token}`,
  sessionView: `http://127.0.0.1:${PORT}/session?token=${sessionToken.token}`,
};

server.listen(PORT, "127.0.0.1", () => {
  console.log(`admin preview: ${urls.admin}`);
  console.log(`vault preview: ${urls.vault}`);
  console.log(`session view preview: ${urls.sessionView}`);
  console.log(`workspace: ${WS}`);
  console.log(`state: ${STATE}`);
});
