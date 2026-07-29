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
  ConversationKind,
  MessagingInfo,
  OfficeAddress,
  OfficeKey,
  PlatformBlockKit,
  PlatformName,
  PlatformNotifier,
  PlatformReactor,
  PlatformUploader,
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
  T extends Omit<ConversationEvent, "address" | "conversationId">,
>(input: T & ConversationIdentityInput): T & ConversationEvent {
  const address = resolveConversationAddress(input);
  return { ...input, address, conversationId: address.conversationId };
}

/** Normalize a platform response context into one authoritative identity. */
export function createConversationMessage<
  T extends Omit<ConversationMessage, "address" | "conversationId">,
>(input: T & ConversationIdentityInput): T & ConversationMessage {
  const address = resolveConversationAddress(input);
  return { ...input, address, conversationId: address.conversationId };
}
