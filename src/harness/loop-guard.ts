import type { ToolLoopVerdict } from "./types.js";

const TRACK_WINDOW = 64;
const IDENTICAL_NOTICE_AT = 3;
const IDENTICAL_BLOCK_AT = 5;
const IDENTICAL_STOP_AT = 10;
const CYCLE_MIN_PERIOD = 2;
const CYCLE_MAX_PERIOD = 6;
const CYCLE_NOTICE_REPETITIONS = 3;
const CYCLE_RENOTICE_FACTOR = 2;

interface CallRecord {
  toolName: string;
  signature: string;
}

export class ToolLoopGuard {
  private readonly records: CallRecord[] = [];
  private readonly cycleNotices = new Map<string, number>();

  observe(toolName: string, args: Record<string, unknown>): ToolLoopVerdict {
    this.records.push({ toolName, signature: callSignature(toolName, args) });
    if (this.records.length > TRACK_WINDOW) this.records.shift();

    const identical = this.identicalRunLength();
    if (identical >= IDENTICAL_STOP_AT) {
      return {
        kind: "stop",
        reason: `tool loop: ${toolName} called ${identical} times in a row with identical arguments`,
      };
    }
    if (identical >= IDENTICAL_BLOCK_AT) {
      return {
        kind: "block",
        reason: `${toolName} was called ${identical} times in a row with identical arguments, so this call was not executed. Its result would not change. Take a different approach, or tell the user what is blocking progress.`,
      };
    }
    if (identical >= IDENTICAL_NOTICE_AT) {
      return {
        kind: "notice",
        text: `[loop guard] This is call ${identical} in a row of ${toolName} with identical arguments. Repeating it returns the same result. If you are waiting for something to change, wait inside a single bounded command instead; otherwise change your approach.`,
      };
    }
    return this.cycleVerdict();
  }

  private identicalRunLength(): number {
    const last = this.records.at(-1);
    let run = 0;
    for (let index = this.records.length - 1; index >= 0; index--) {
      if (this.records[index]?.signature !== last?.signature) break;
      run++;
    }
    return run;
  }

  private cycleVerdict(): ToolLoopVerdict {
    const total = this.records.length;
    for (let period = CYCLE_MIN_PERIOD; period <= CYCLE_MAX_PERIOD; period++) {
      if (total < period * CYCLE_NOTICE_REPETITIONS) continue;
      const cycle = this.records.slice(total - period);
      if (new Set(cycle.map((record) => record.signature)).size < 2) continue;
      const repetitions = this.cycleRepetitions(period);
      if (repetitions < CYCLE_NOTICE_REPETITIONS) continue;
      const key = cycleKey(cycle);
      const notified = this.cycleNotices.get(key);
      if (notified !== undefined && repetitions < notified * CYCLE_RENOTICE_FACTOR) {
        return { kind: "allow" };
      }
      this.cycleNotices.set(key, repetitions);
      const tools = cycle.map((record) => record.toolName).join(" → ");
      return {
        kind: "notice",
        text: `[loop guard] The same sequence of ${period} tool calls (${tools}) has repeated ${repetitions} times with identical arguments. It is not making progress; change your approach.`,
      };
    }
    return { kind: "allow" };
  }

  private cycleRepetitions(period: number): number {
    const total = this.records.length;
    let repetitions = 1;
    while ((repetitions + 1) * period <= total) {
      const blockStart = total - (repetitions + 1) * period;
      for (let offset = 0; offset < period; offset++) {
        if (
          this.records[blockStart + offset]?.signature !==
          this.records[total - period + offset]?.signature
        ) {
          return repetitions;
        }
      }
      repetitions++;
    }
    return repetitions;
  }
}

function cycleKey(cycle: CallRecord[]): string {
  return cycle
    .map((record) => record.signature)
    .toSorted()
    .join("\n");
}

function callSignature(toolName: string, args: Record<string, unknown>): string {
  const { label: _label, ...identity } = args;
  return `${toolName}\u0000${canonicalJson(identity)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
