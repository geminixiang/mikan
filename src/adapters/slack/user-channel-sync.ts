import { WebClient } from "@slack/web-api";
import type { SlackChannel, SlackUser } from "./types.js";

export async function fetchUsers(deps: {
  webClient: WebClient;
  users: Map<string, SlackUser>;
}): Promise<void> {
  let cursor: string | undefined;
  do {
    const result = await deps.webClient.users.list({ limit: 200, cursor });
    const members = result.members as
      | Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
      | undefined;
    if (members) {
      for (const u of members) {
        if (u.id && u.name && !u.deleted) {
          deps.users.set(u.id, {
            id: u.id,
            userName: u.name,
            displayName: u.real_name || u.name,
          });
        }
      }
    }
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);
}

export async function fetchChannels(deps: {
  webClient: WebClient;
  users: Map<string, SlackUser>;
  channels: Map<string, SlackChannel>;
}): Promise<void> {
  // Fetch public/private channels
  let cursor: string | undefined;
  do {
    const result = await deps.webClient.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    const channels = result.channels as
      | Array<{ id?: string; name?: string; is_member?: boolean }>
      | undefined;
    if (channels) {
      for (const c of channels) {
        if (c.id && c.name && c.is_member) {
          deps.channels.set(c.id, { id: c.id, name: c.name });
        }
      }
    }
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  // Also fetch DM channels (IMs)
  cursor = undefined;
  do {
    const result = await deps.webClient.conversations.list({
      types: "im",
      limit: 200,
      cursor,
    });
    const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
    if (ims) {
      for (const im of ims) {
        if (im.id) {
          // Use user's name as channel name for DMs
          const user = im.user ? deps.users.get(im.user) : undefined;
          const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
          deps.channels.set(im.id, { id: im.id, name });
        }
      }
    }
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);
}
