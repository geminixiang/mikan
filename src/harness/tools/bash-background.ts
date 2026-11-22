import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  JOBS_DIR_NAME,
  JOB_LIMIT_MS,
  formatJobDuration,
  type BackgroundJobSink,
} from "../../events/jobs.js";
import type { Office } from "../../office/types.js";
import type { ConversationKind } from "../../types.js";
import type { MikanToolContext } from "../types.js";
import { withLabelParameter } from "./host-fn-tool.js";

const BASH_BACKGROUND_TOOL = "bash_background";

const EXIT_NO_SETSID = 96;
const EXIT_ALREADY_STARTED = 97;

const RUN_IN_OWN_GROUP = `setsid sh -c 'echo $$ > "$2/pid"; exec "$3" -c "$1"' job "$1" "$2" "$3"`;
const WRAPPER = `${RUN_IN_OWN_GROUP} & wait $!; echo $? > "$2/exit.tmp"; mv "$2/exit.tmp" "$2/exit"`;

const START_SCRIPT = [
  `command -v setsid >/dev/null 2>&1 || exit ${EXIT_NO_SETSID}`,
  'd="$MIKAN_JOB_DIR"',
  `[ -e "$d" ] && exit ${EXIT_ALREADY_STARTED}`,
  'mkdir -p "$(dirname "$d")" && mkdir "$d" || exit 98',
  "shell=$(command -v bash || echo sh)",
  `setsid sh -c '${WRAPPER.replaceAll("'", `'\\''`)}' job "$MIKAN_JOB_CMD" "$d" "$shell" </dev/null >"$d/log" 2>&1 &`,
].join("\n");

const START_ERROR_CHARS = 500;

const parameters = Type.Object({
  command: Type.String({
    minLength: 1,
    description: "The shell command to run in the background, as you would give it to bash.",
  }),
});

export interface BackgroundJobRunContext {
  sessionKey: string;
  threadTs: string | undefined;
  userId: string;
  conversationKind: ConversationKind;
  runtimeWorkspaceRoot: string;
}

const LIMIT = formatJobDuration(JOB_LIMIT_MS);

export function createBashBackgroundTool(
  toolContext: MikanToolContext,
  jobs: BackgroundJobSink,
  office: Office,
): { tool: ToolRegistration; setRunContext: (context: BackgroundJobRunContext) => void } {
  let run: BackgroundJobRunContext | undefined;
  const tool: ToolRegistration = {
    name: BASH_BACKGROUND_TOOL,
    replay: "safe",
    description: `Start a shell command that keeps running after this call returns, and get its job ID at once. Use it for a command that takes minutes, such as a build, a test suite, or a download, so the conversation stays free; use bash for anything short. The output goes to a log file, not to you. When the job exits, a message starting with \`[job <id> exited <code> ...]\` arrives in this conversation naming the log file, and you get a turn to read it and act on it; tell the user you will report back, then end your turn instead of waiting. To look earlier, read the log with bash; to stop a job, kill its process group with the command this call returns. Limits: a job is killed after ${LIMIT}; it gets no stdin; it survives a restart of the service, \`stop\`, and \`/new\` (its message then arrives in the new context), but not a stop or replacement of the sandbox, which you learn only at the ${LIMIT} limit.`,
    parameters: withLabelParameter(parameters, "required"),
    execute: async (args, api, context) => {
      const env = toolContext.env();
      if (!env || !run) {
        throw new Error("Background jobs are unavailable here; run the command with bash.");
      }
      const { command, label } = args as { command: string; label: string };
      const id = await api.memo("job", randomBytes(4).toString("hex"), context);
      const dir = posix.join(run.runtimeWorkspaceRoot, office.key, JOBS_DIR_NAME, id);
      jobs.register(office, {
        id,
        command,
        label,
        sessionKey: run.sessionKey,
        threadTs: run.threadTs,
        userId: run.userId,
        conversationKind: run.conversationKind,
        guestDir: dir,
      });
      let output = "";
      const started = await env.exec(
        START_SCRIPT,
        {
          env: { MIKAN_JOB_DIR: dir, MIKAN_JOB_CMD: command },
          onOutput: (text) => {
            if (output.length < START_ERROR_CHARS) output += text;
          },
        },
        context,
      );
      if (!started.ok) {
        throw new Error(
          `The start of job ${id} could not be confirmed (${started.error.message}). If it started, its exit message will still arrive; check ${dir} with bash.`,
        );
      }
      const { exitCode } = started.value;
      if (exitCode !== 0 && exitCode !== EXIT_ALREADY_STARTED) {
        jobs.forget(office, id);
        throw new Error(
          exitCode === EXIT_NO_SETSID
            ? "This sandbox has no `setsid` command, which background jobs need. Install it (util-linux) or run the command with bash."
            : `The job could not be started (exit ${exitCode}): ${output.slice(0, START_ERROR_CHARS).trim()}`,
        );
      }
      return {
        output: [
          {
            type: "text",
            text: [
              `Started job ${id}. A message arrives in this conversation when it exits; it is killed after ${LIMIT}.`,
              `log: ${dir}/log`,
              `exit code, once it has exited: ${dir}/exit`,
              `process group: ${dir}/pid`,
              `Read output with bash, for example \`tail -n 50 ${dir}/log\`. Stop it with \`kill -- -$(cat ${dir}/pid)\`.`,
            ].join("\n"),
          },
        ],
      };
    },
  };
  return {
    tool,
    setRunContext: (context) => {
      run = context;
    },
  };
}
