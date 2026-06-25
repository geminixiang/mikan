import type { MessagingBot, MessagingInfo } from "./adapter.js";

export const PRODUCT_NAME = "mikan";

type PlatformSource = MessagingBot | MessagingInfo | string;

function resolvePlatformName(source: PlatformSource): string {
  if (typeof source === "string") return source;
  if ("getMessagingInfo" in source) return source.getMessagingInfo().name;
  return source.name;
}

function supportsHtmlFormatting(platformName: string): boolean {
  return platformName === "telegram";
}

function formatItalic(platformName: string, text: string): string {
  return supportsHtmlFormatting(platformName) ? text : `_${text}_`;
}

function formatCode(platformName: string, text: string): string {
  return supportsHtmlFormatting(platformName) ? `<code>${text}</code>` : `\`${text}\``;
}

export function formatNothingRunning(source: PlatformSource): string {
  return formatItalic(resolvePlatformName(source), "Nothing running.");
}

export function formatStopping(source: PlatformSource): string {
  return formatItalic(resolvePlatformName(source), "Stopping…");
}

export function formatStopped(source: PlatformSource): string {
  return formatItalic(resolvePlatformName(source), "Stopped.");
}

export function formatAlreadyWorking(
  source: PlatformSource,
  stopCommand: string,
  options?: { scope?: "thread" },
): string {
  const platformName = resolvePlatformName(source);
  const command = formatCode(platformName, stopCommand);
  const prefix =
    options?.scope === "thread" ? "Already working in this thread." : "Already working.";
  return formatItalic(platformName, `${prefix} Send ${command} to cancel.`);
}

export function formatForceStopped(source: PlatformSource, actorLabel: string): string {
  return formatItalic(resolvePlatformName(source), `Force stopped by ${actorLabel}.`);
}
