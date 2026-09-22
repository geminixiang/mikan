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

type CanonicalConversation<T, Shape> = Omit<T, keyof ConversationIdentityInput> & Shape;

export function createConversationEvent<T extends Omit<ConversationEvent, "address">>(
  input: T & ConversationIdentityInput,
): CanonicalConversation<T, ConversationEvent> {
  const address = resolveConversationAddress(input);
  const {
    platform: _platform,
    conversationId: _conversationId,
    address: _suppliedAddress,
    ...event
  } = input;
  return { ...event, address } as CanonicalConversation<T, ConversationEvent>;
}

export function createConversationMessage<T extends Omit<ConversationMessage, "address">>(
  input: T & ConversationIdentityInput,
): CanonicalConversation<T, ConversationMessage> {
  const address = resolveConversationAddress(input);
  const {
    platform: _platform,
    conversationId: _conversationId,
    address: _suppliedAddress,
    ...message
  } = input;
  return { ...message, address } as CanonicalConversation<T, ConversationMessage>;
}
