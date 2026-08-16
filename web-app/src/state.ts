import type { SubagentProgressNode } from "../../src/types.js";
import type {
  WebQueueItem,
  WebRunSnapshot,
  WebSessionHistory,
  WebStreamFrame,
  WebToolSnapshot,
  WebWorkspace,
} from "../../src/web/harness/protocol.js";

interface LiveNotice {
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface WorkspaceLiveState {
  readonly generation: string | null;
  readonly connection: "connecting" | "open" | "closed";
  readonly workspace: WebWorkspace | null;
  readonly history: WebSessionHistory | null;
  readonly run: WebRunSnapshot | null;
  readonly queue: readonly WebQueueItem[];
  readonly subagents: readonly SubagentProgressNode[];
  readonly tools: Readonly<Record<string, WebToolSnapshot>>;
  readonly notices: readonly LiveNotice[];
}

export const initialLiveState: WorkspaceLiveState = {
  generation: null,
  connection: "connecting",
  workspace: null,
  history: null,
  run: null,
  queue: [],
  subagents: [],
  tools: {},
  notices: [],
};

export type LiveAction =
  | { readonly type: "connection"; readonly status: WorkspaceLiveState["connection"] }
  | { readonly type: "frame"; readonly frame: WebStreamFrame }
  | { readonly type: "reset" };

export function liveReducer(state: WorkspaceLiveState, action: LiveAction): WorkspaceLiveState {
  if (action.type === "reset") return initialLiveState;
  if (action.type === "connection") return { ...state, connection: action.status };
  return reduceFrame(state, action.frame);
}

function reduceFrame(state: WorkspaceLiveState, frame: WebStreamFrame): WorkspaceLiveState {
  switch (frame.type) {
    case "stream.ready":
      return frame.generation === state.generation
        ? { ...state, connection: "open" }
        : {
            ...initialLiveState,
            generation: frame.generation,
            connection: "open",
          };
    case "workspace.snapshot":
      return { ...state, workspace: frame.workspace };
    case "session.snapshot":
      return { ...state, history: frame.session };
    case "run.snapshot": {
      const runChanged = state.run?.id !== frame.run?.id;
      return {
        ...state,
        run: frame.run,
        ...(runChanged ? { subagents: [], tools: {} } : {}),
      };
    }
    case "queue.snapshot":
      return { ...state, queue: frame.items };
    case "subagents.snapshot":
      return { ...state, subagents: frame.items };
    case "response.delta":
      return frame.runId === state.run?.id
        ? { ...state, run: { ...state.run, responseText: state.run.responseText + frame.text } }
        : state;
    case "response.final":
      return frame.runId === state.run?.id
        ? { ...state, run: { ...state.run, responseText: frame.text } }
        : state;
    case "tool.started":
    case "tool.finished":
      if (frame.runId !== state.run?.id) return state;
      return { ...state, tools: { ...state.tools, [frame.tool.id]: frame.tool } };
    case "diagnostic":
      return appendNotice(state, frame.level, frame.message, frame.runId ?? "global");
    case "error":
      return appendNotice(
        state,
        "error",
        frame.message,
        frame.runId ?? frame.requestId ?? "global",
      );
  }
}

function appendNotice(
  state: WorkspaceLiveState,
  level: LiveNotice["level"],
  message: string,
  key: string,
): WorkspaceLiveState {
  const notice = { id: `${key}:${state.notices.length}`, level, message };
  return { ...state, notices: [...state.notices.slice(-4), notice] };
}

export function readWorkspaceRoute(pathname: string): string | null {
  const match = /^\/w\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id && !id.includes("/") && !id.includes("\\") ? id : null;
  } catch {
    return null;
  }
}

export function workspaceRoute(workspaceId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}`;
}

export function oauthErrorFromLocation(location: Location): string | null {
  const code = new URLSearchParams(location.search).get("authError");
  if (!code) return null;
  const messages: Readonly<Record<string, string>> = {
    denied: "Sign-in was cancelled.",
    invalid_state: "That sign-in request expired. Please try again.",
    missing_code: "The provider did not return a sign-in code.",
    provider_failed: "The provider could not complete sign-in. Please try again.",
    unavailable: "Account sign-in is not configured right now.",
  };
  return messages[code] ?? "Sign-in could not be completed.";
}
