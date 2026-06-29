import { completeSimple } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "./harness/auth-storage.js";
import { ModelRegistry } from "./harness/model-registry.js";
import type { ConversationEvent } from "./adapter.js";
import { loadAutoReplyJudgeModel, loadConversationAutoReplyConfig } from "./config.js";
import * as log from "./log.js";
import { homedir } from "os";
import { join } from "path";
import { resolveConfiguredModel } from "./model-registry.js";

const JUDGE_TIMEOUT_MS = 10_000;

export type { AutoReplyJudge, TriggerIntent, TriggerResult } from "./types.js";
import type { AutoReplyJudge, TriggerIntent, TriggerResult } from "./types.js";

/**
 * Trivially decide non-auto-reply intents synchronously. For "auto-reply-candidate"
 * callers must use {@link evaluateAutoReplyPolicy}.
 */
export function decideTrigger(
  intent: Exclude<TriggerIntent, "auto-reply-candidate">,
): TriggerResult {
  return { trigger: true, reason: intent };
}

/**
 * Decide whether to auto-reply. Never throws — judge errors and timeouts are
 * folded into a `trigger: false` result with a distinct reason, so adapters
 * can apply a single uniform "do not trigger, but still log" policy.
 *
 * @deprecated Auto-reply is kept for compatibility while its future is undecided.
 */
export async function evaluateAutoReplyPolicy(input: {
  event: ConversationEvent;
  workingDir: string | undefined;
  judge?: AutoReplyJudge;
  timeoutMs?: number;
}): Promise<TriggerResult> {
  const { event, workingDir, judge = judgeAutoReplyWithLlm, timeoutMs = JUDGE_TIMEOUT_MS } = input;
  if (!workingDir) return { trigger: false, reason: "auto-reply-unconfigured" };

  const conversationDir = join(workingDir, event.conversationId);

  try {
    const config = loadConversationAutoReplyConfig(conversationDir);
    if (!config.enabled) return { trigger: false, reason: "auto-reply-disabled" };
    if (config.rules.length === 0) {
      return { trigger: true, reason: "auto-reply-enabled" };
    }

    const shouldReply = await withTimeout(
      judge({ event, rules: config.rules, conversationDir }),
      timeoutMs,
    );
    return shouldReply
      ? { trigger: true, reason: "auto-reply-rule-match" }
      : { trigger: false, reason: "auto-reply-rule-no-match" };
  } catch (err) {
    if (err instanceof JudgeTimeoutError) {
      log.logWarning("Auto-reply judge timed out", String(err));
      return { trigger: false, reason: "auto-reply-judge-timeout" };
    }
    log.logWarning("Auto-reply policy evaluation failed", String(err));
    return { trigger: false, reason: "auto-reply-judge-failed" };
  }
}

class JudgeTimeoutError extends Error {
  constructor(ms: number) {
    super(`auto-reply judge exceeded ${ms}ms`);
    this.name = "JudgeTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new JudgeTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function judgeAutoReplyWithLlm(input: {
  event: ConversationEvent;
  rules: string[];
  conversationDir: string;
}): Promise<boolean> {
  const judgeConfig = loadAutoReplyJudgeModel(input.conversationDir);
  const modelRegistry = ModelRegistry.create(
    AuthStorage.create(join(homedir(), ".mikan", "auth.json")),
  );
  const model = resolveConfiguredModel(modelRegistry, judgeConfig.provider, judgeConfig.model);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }

  const answer = await completeSimple(
    model,
    {
      systemPrompt:
        "You decide whether a bot should reply to a group/channel message. " +
        "Use only the rules provided by the user. Answer exactly YES or NO.",
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            "Rules:",
            ...input.rules.map((rule, index) => `${index + 1}. ${rule}`),
            "",
            "Message:",
            input.event.text,
            "",
            "Should the bot reply? Answer exactly YES or NO.",
          ].join("\n"),
        },
      ],
    },
    {
      temperature: 0,
      maxTokens: 4,
      reasoning: "minimal",
      apiKey: auth.apiKey,
      headers: auth.headers,
    },
  );
  const text = answer.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
    .toUpperCase();
  return /^YES\b/.test(text);
}
