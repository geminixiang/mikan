import { get } from "node:https";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { SlackSocketAgent } from "../adapters/slack/socket-agent.js";

const servers: Server[] = [];
const accepted: Socket[] = [];

afterEach(async () => {
  for (const socket of accepted.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function silentServer(): Promise<number> {
  const server = createServer((socket) => accepted.push(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return address.port;
}

function request(port: number, agent: SlackSocketAgent): Promise<string> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/", agent, rejectUnauthorized: false });
    req.on("response", () => resolve("response"));
    req.on("error", (error) => resolve(error.message));
  });
}

describe("SlackSocketAgent", () => {
  test("fails a connection whose peer never answers instead of waiting forever", async () => {
    const port = await silentServer();
    const startedAt = Date.now();

    const outcome = await request(port, new SlackSocketAgent(200));

    expect(outcome).toBe("Slack connection got no response within 200ms");
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});
