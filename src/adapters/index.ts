import { createOfficeAddress, sameOffice } from "../office/index.js";
import type {
  ConversationEvent,
  ConversationMessage,
  OfficeAddress,
  PlatformName,
} from "../types.js";

export type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  HandleNewCommandOptions,
  ConversationMessage,
  ConversationResponder,
  ChatToolResult,
  ConversationKind,
  MessagingInfo,
  OfficeAddress,
  OfficeKey,
  PlatformHistoryMessage,
  PlatformHistoryOptions,
  PlatformName,
  PlatformUserInfo,
  RunningSession,
  SubagentProgressSnapshot,
} from "../types.js";

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

export function createConversationEvent<
  T extends Omit<ConversationEvent, "address" | "conversationId">,
>(input: T & ConversationIdentityInput): T & ConversationEvent {
  const address = resolveConversationAddress(input);
  return { ...input, address, conversationId: address.conversationId };
}

export function createConversationMessage<
  T extends Omit<ConversationMessage, "address" | "conversationId">,
>(input: T & ConversationIdentityInput): T & ConversationMessage {
  const address = resolveConversationAddress(input);
  return { ...input, address, conversationId: address.conversationId };
}
