import type { ClientRequestArgs } from "node:http";
import { Agent } from "node:https";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";

const SLACK_CONNECTION_STALL_MS = 30_000;

export class SlackSocketAgent extends Agent {
  private readonly stallMs: number;

  constructor(stallMs = SLACK_CONNECTION_STALL_MS) {
    super();
    this.stallMs = stallMs;
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const stream = super.createConnection(options, callback);
    if (stream instanceof Socket) {
      stream.setTimeout(this.stallMs, () =>
        stream.destroy(new Error(`Slack connection got no response within ${this.stallMs}ms`)),
      );
    }
    return stream;
  }
}
