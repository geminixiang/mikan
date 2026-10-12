import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryDesktopTokenStore } from "../adapters/web/desktop/index.js";
import { InMemoryLinkTokenStore } from "../adapters/web/login/portal.js";
import { startWebServer } from "../adapters/web/server.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { VaultManager } from "../vault/types.js";

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.close();
    await once(server, "close");
  }
  server = undefined;
});

function fakeDesktop() {
  const upstream = new PassThrough();
  const output = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const desktop = {
    start: vi.fn(async () => "ready" as const),
    status: vi.fn(async () => ({ display: "wayland-1", control: "agent" as const })),
    setBrowserOwner: vi.fn(async () => {}),
    connect: vi.fn(() => ({ input: upstream, output, process: proc, close: vi.fn() })),
  };
  return { desktop, upstream, output };
}

async function serve(desktop: ReturnType<typeof fakeDesktop>["desktop"]) {
  const tokenStore = new InMemoryDesktopTokenStore();
  const workspace = createWorkspace({
    root: "/tmp/mikan-desktop-web",
    stateDir: "/tmp/mikan-desktop-web/state",
  });
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  const { token } = tokenStore.create({ platform: "slack", platformUserId: "U1", office });
  server = startWebServer({
    port: 0,
    host: "127.0.0.1",
    linkTokenStore: new InMemoryLinkTokenStore(),
    vaultManager: {} as VaultManager,
    notify: async () => {},
    desktop: { tokenStore, desktop },
  });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, token, key: office.key };
}

describe("desktop web routes", () => {
  test("a valid link serves the desktop page, a forged one does not", async () => {
    const { desktop } = fakeDesktop();
    const { base, token } = await serve(desktop);

    const page = await fetch(`${base}/desktop?token=${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("desktop/novnc/core/rfb.js");

    expect((await fetch(`${base}/desktop?token=forged`)).status).toBe(404);
  });

  test("serves the noVNC client modules and nothing outside them", async () => {
    const { desktop } = fakeDesktop();
    const { base } = await serve(desktop);

    const rfb = await fetch(`${base}/desktop/novnc/core/rfb.js`);
    expect(rfb.status).toBe(200);
    expect(rfb.headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${base}/desktop/novnc/package.json`)).status).toBe(404);
    expect((await fetch(`${base}/desktop/novnc/core/..%2f..%2fpackage.json`)).status).toBe(404);
  });

  test("control hands the browser to the person and back", async () => {
    const { desktop } = fakeDesktop();
    const { base, token, key } = await serve(desktop);

    const taken = await fetch(`${base}/desktop/control?token=${token}`, {
      method: "POST",
      body: JSON.stringify({ owner: "user" }),
    });

    expect(taken.status).toBe(200);
    expect(desktop.setBrowserOwner).toHaveBeenCalledWith(key, "user");
    const forged = await fetch(`${base}/desktop/control?token=forged`, {
      method: "POST",
      body: JSON.stringify({ owner: "user" }),
    });
    expect(forged.status).toBe(404);
  });

  test("the WebSocket forwards to the office desktop only with a valid token", async () => {
    const { desktop, upstream, output } = fakeDesktop();
    const { base, token, key } = await serve(desktop);
    const forwarded: string[] = [];
    upstream.on("data", (chunk: Buffer) => forwarded.push(chunk.toString()));

    const forged = new WebSocket(`${base.replace("http", "ws")}/desktop/ws?token=forged`);
    await new Promise((resolve) => forged.addEventListener("error", resolve));
    expect(desktop.connect).not.toHaveBeenCalled();

    const socket = new WebSocket(`${base.replace("http", "ws")}/desktop/ws?token=${token}`);
    await vi.waitFor(() => expect(forwarded.join("")).toMatch(/upgrade: websocket/i));
    expect(desktop.start).toHaveBeenCalledWith(key);
    expect(desktop.connect).toHaveBeenCalledWith(key);
    expect(forwarded.join("")).toMatch(/^GET \/ HTTP\/1\.1\r\nHost: 127\.0\.0\.1\r\n/);
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
    output.end();
    await closed;
  });
});
