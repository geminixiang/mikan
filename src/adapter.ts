import { createOfficeAddress, sameOffice } from "./office/index.js";
import type {
  ConversationEvent,
  ConversationMessage,
  OfficeAddress,
  PlatformName,
} from "./types.js";

export type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  ChatAdapter,
  ConversationMessage,
  ConversationResponder,
  ChatToolResult,
  ChatToolStart,
  ConversationKind,
  ConversationRunOrigin,
  MessagingInfo,
  OfficeAddress,
  OfficeKey,
  PlatformBlockKit,
  PlatformDmOpener,
  PlatformHistoryFetcher,
  PlatformHistoryMessage,
  PlatformHistoryOptions,
  PlatformName,
  PlatformNotifier,
  PlatformReactor,
  PlatformUploader,
  PlatformUserInfo,
  PlatformUserLister,
  RunningSession,
  SubagentProgressSnapshot,
} from "./types.js";

interface ConversationIdentityInput {
  platform: PlatformName;
  conversationId: string;
  address?: OfficeAddress;
}

function resolveConversationAddress(input: ConversationIdentityInput): OfficeAddress {
  const address = createOfficeAddress(input.platform, input.conversationId);
  if (input.address && !sameOffice(address, input.address)) {
    throw new Error(
      `Conversation address mismatch for ${JSON.stringify(input.conversationId)} on ${input.platform}`,
    );
  }
  return address;
}

/** Normalize platform intake into one authoritative conversation identity. */
export function createConversationEvent<
  T extends Omit<ConversationEvent, "address" | "conversationId" | "origin">,
>(
  input: T & ConversationIdentityInput & { origin?: ConversationEvent["origin"] },
): T & ConversationEvent {
  const address = resolveConversationAddress(input);
  return {
    ...input,
    address,
    conversationId: address.conversationId,
    origin: input.origin ?? { kind: "interactive" },
  };
}

/** Normalize a platform response context into one authoritative identity. */
export function createConversationMessage<
  T extends Omit<ConversationMessage, "address" | "conversationId" | "origin">,
>(
  input: T & ConversationIdentityInput & { origin?: ConversationMessage["origin"] },
): T & ConversationMessage {
  const address = resolveConversationAddress(input);
  return {
    ...input,
    address,
    conversationId: address.conversationId,
    origin: input.origin ?? { kind: "interactive" },
  };
}
