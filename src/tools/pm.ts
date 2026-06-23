import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { EventPayload } from "./event.js";
import * as log from "../log.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  description?: string;
  ownerConversationId: string;
  /** 'workspace' | 'private' | comma-separated conversationIds */
  visibility: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

interface Task {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: "todo" | "in_progress" | "done" | "blocked";
  assigneeUserId?: string;
  assigneeConversationId?: string;
  dueDate?: string;
  sourceConversationId: string;
  createdAt: number;
  updatedAt: number;
}

interface Reminder {
  id: string;
  taskId?: string;
  projectId?: string;
  cron: string;
  timezone: string;
  targetConversationId: string;
  targetConversationKind: "direct" | "shared";
  targetPlatform: string;
  targetUserId: string;
  eventFilename?: string;
  createdAt: number;
}

interface PMData {
  version: 1;
  projects: Record<string, Project>;
  tasks: Record<string, Task>;
  reminders: Record<string, Reminder>;
}

export interface PMContext {
  platform: string;
  conversationId: string;
  conversationKind: "direct" | "shared";
  userId: string;
}

// ── Schema ─────────────────────────────────────────────────────────────────

const pmSchema = Type.Object({
  label: Type.String({ description: "Brief description shown to user" }),
  action: Type.Union(
    [
      Type.Literal("project_create"),
      Type.Literal("project_list"),
      Type.Literal("project_get"),
      Type.Literal("task_create"),
      Type.Literal("task_update"),
      Type.Literal("task_list"),
      Type.Literal("task_get"),
      Type.Literal("reminder_set"),
      Type.Literal("reminder_list"),
      Type.Literal("reminder_delete"),
      Type.Literal("status_report"),
    ],
    {
      description:
        "PM operation: project_create/list/get, task_create/update/list/get, reminder_set/list/delete, status_report",
    },
  ),
  // Project fields
  project_id: Type.Optional(
    Type.String({
      description: "Project ID — required for project_get, task_create, task_list, reminder_set",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Project name (project_create) or task title (task_create)" }),
  ),
  description: Type.Optional(Type.String({ description: "Description for project or task" })),
  visibility: Type.Optional(
    Type.String({
      description:
        "Project visibility: 'workspace' (default, all conversations), 'private' (owner only), or comma-separated conversationIds",
    }),
  ),
  // Task fields
  task_id: Type.Optional(
    Type.String({ description: "Task ID — required for task_update, task_get, reminder_set" }),
  ),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("todo"),
        Type.Literal("in_progress"),
        Type.Literal("done"),
        Type.Literal("blocked"),
      ],
      { description: "Task status" },
    ),
  ),
  assignee_user_id: Type.Optional(
    Type.String({ description: "Assignee's platform user ID (e.g. U12345 on Slack)" }),
  ),
  assignee_conversation_id: Type.Optional(
    Type.String({
      description:
        "Assignee's DM conversation ID for reminder routing (e.g. D12345 on Slack). When set on reminder_set with no target_conversation_id, also creates a DM reminder to the assignee.",
    }),
  ),
  due_date: Type.Optional(Type.String({ description: "Due date as YYYY-MM-DD" })),
  note: Type.Optional(Type.String({ description: "Update note or comment appended to activity" })),
  // Reminder fields
  reminder_id: Type.Optional(
    Type.String({ description: "Reminder ID — required for reminder_delete" }),
  ),
  cron: Type.Optional(
    Type.String({
      description: "Cron expression for the periodic reminder (e.g. '0 9 * * 1-5')",
    }),
  ),
  timezone: Type.Optional(
    Type.String({ description: "IANA timezone for the cron schedule (e.g. 'Asia/Taipei')" }),
  ),
  target_conversation_id: Type.Optional(
    Type.String({
      description:
        "Target conversation ID for the reminder. Defaults to current conversation. Pass the assignee DM ID to route to them directly.",
    }),
  ),
  target_conversation_kind: Type.Optional(
    Type.Union([Type.Literal("direct"), Type.Literal("shared")], {
      description: "Conversation kind for target: 'shared' (channel, default) or 'direct' (DM)",
    }),
  ),
  // Filters for list actions
  filter_status: Type.Optional(
    Type.String({ description: "Filter tasks by status: todo, in_progress, done, blocked" }),
  ),
  filter_due_before: Type.Optional(
    Type.String({ description: "Filter tasks due before this date (YYYY-MM-DD)" }),
  ),
});

type PMParams = {
  label: string;
  action: string;
  project_id?: string;
  name?: string;
  description?: string;
  visibility?: string;
  task_id?: string;
  status?: "todo" | "in_progress" | "done" | "blocked";
  assignee_user_id?: string;
  assignee_conversation_id?: string;
  due_date?: string;
  note?: string;
  reminder_id?: string;
  cron?: string;
  timezone?: string;
  target_conversation_id?: string;
  target_conversation_kind?: "direct" | "shared";
  filter_status?: string;
  filter_due_before?: string;
};

// ── Persistence ────────────────────────────────────────────────────────────

async function loadData(pmDir: string): Promise<PMData> {
  const filePath = join(pmDir, "data.json");
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as PMData;
  } catch {
    return { version: 1, projects: {}, tasks: {}, reminders: {} };
  }
}

async function saveData(pmDir: string, data: PMData): Promise<void> {
  await mkdir(pmDir, { recursive: true });
  await writeFile(join(pmDir, "data.json"), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function canAccess(project: Project, conversationId: string): boolean {
  if (project.visibility === "workspace") return true;
  if (project.visibility === "private") return project.ownerConversationId === conversationId;
  const allowed = project.visibility.split(",").map((s) => s.trim());
  return allowed.includes(conversationId) || project.ownerConversationId === conversationId;
}

function shortId(): string {
  return randomUUID().split("-")[0];
}

function tasksForProject(data: PMData, projectId: string): Task[] {
  return Object.values(data.tasks).filter((t) => t.projectId === projectId);
}

function formatTask(task: Task): string {
  const due = task.dueDate ? ` | due: ${task.dueDate}` : "";
  const assignee = task.assigneeUserId ? ` | assignee: ${task.assigneeUserId}` : "";
  return `[${task.id}] ${task.title} (${task.status})${due}${assignee}`;
}

function formatProject(project: Project, tasks: Task[]): string {
  const counts = { todo: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const t of tasks) counts[t.status]++;
  return (
    `[${project.id}] ${project.name} (${project.status}) ` +
    `todo:${counts.todo} in_progress:${counts.in_progress} done:${counts.done} blocked:${counts.blocked}`
  );
}

function buildReminderText(label: string, project?: Project, task?: Task): string {
  const parts: string[] = [`[PM REMINDER] ${label}`];
  if (project) parts.push(`Project: ${project.name} (${project.id})`);
  if (task) {
    parts.push(`Task: ${task.title} | Status: ${task.status}`);
    if (task.dueDate) parts.push(`Due: ${task.dueDate}`);
    if (task.assigneeUserId) parts.push(`Assignee: ${task.assigneeUserId}`);
    parts.push(`Task ID: ${task.id}`);
  }
  parts.push(
    "Review the task status and send a brief follow-up if action is needed. " +
      "Use the pm tool (action: task_get) to fetch current details. " +
      "Respond with [SILENT] if the task is already done or no follow-up is needed.",
  );
  return parts.join("\n");
}

async function writeEventFile(
  eventsDir: string,
  filename: string,
  payload: EventPayload,
): Promise<void> {
  await mkdir(eventsDir, { recursive: true });
  await writeFile(join(eventsDir, filename), JSON.stringify(payload) + "\n", "utf-8");
}

async function deleteEventFile(eventsDir: string, filename: string): Promise<void> {
  const path = join(eventsDir, filename);
  if (existsSync(path)) {
    await unlink(path);
  }
}

// ── Action handlers ────────────────────────────────────────────────────────

function handleProjectCreate(data: PMData, params: PMParams, ctx: PMContext): { text: string } {
  if (!params.name) throw new Error("name is required for project_create");
  const id = `proj-${shortId()}`;
  const now = Date.now();
  data.projects[id] = {
    id,
    name: params.name,
    description: params.description,
    ownerConversationId: ctx.conversationId,
    visibility: params.visibility ?? "workspace",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  return {
    text: `Created project [${id}] "${params.name}" (visibility: ${data.projects[id].visibility})`,
  };
}

function handleProjectList(data: PMData, ctx: PMContext): { text: string } {
  const visible = Object.values(data.projects).filter((p) => canAccess(p, ctx.conversationId));
  if (visible.length === 0) return { text: "No projects found." };
  const lines = visible.map((p) => formatProject(p, tasksForProject(data, p.id)));
  return { text: lines.join("\n") };
}

function handleProjectGet(data: PMData, params: PMParams, ctx: PMContext): { text: string } {
  if (!params.project_id) throw new Error("project_id is required for project_get");
  const project = data.projects[params.project_id];
  if (!project) throw new Error(`Project not found: ${params.project_id}`);
  if (!canAccess(project, ctx.conversationId)) throw new Error("Access denied to this project");

  const tasks = tasksForProject(data, project.id);
  const taskLines = tasks.map(formatTask);
  const reminders = Object.values(data.reminders).filter(
    (r) => r.projectId === project.id && !r.taskId,
  );

  const lines = [
    `Project: ${project.name} [${project.id}]`,
    `Status: ${project.status} | Visibility: ${project.visibility}`,
    project.description ? `Description: ${project.description}` : "",
    `Tasks (${tasks.length}):`,
    ...taskLines.map((l) => `  ${l}`),
    reminders.length > 0
      ? `Reminders (${reminders.length}): ${reminders.map((r) => `[${r.id}] ${r.cron} → ${r.targetConversationId}`).join(", ")}`
      : "",
  ].filter(Boolean);

  return { text: lines.join("\n") };
}

function handleTaskCreate(data: PMData, params: PMParams, ctx: PMContext): { text: string } {
  if (!params.project_id) throw new Error("project_id is required for task_create");
  if (!params.name) throw new Error("name is required for task_create");

  const project = data.projects[params.project_id];
  if (!project) throw new Error(`Project not found: ${params.project_id}`);
  if (!canAccess(project, ctx.conversationId)) throw new Error("Access denied to this project");

  const id = `task-${shortId()}`;
  const now = Date.now();
  data.tasks[id] = {
    id,
    projectId: params.project_id,
    title: params.name,
    description: params.description,
    status: params.status ?? "todo",
    assigneeUserId: params.assignee_user_id,
    assigneeConversationId: params.assignee_conversation_id,
    dueDate: params.due_date,
    sourceConversationId: ctx.conversationId,
    createdAt: now,
    updatedAt: now,
  };
  project.updatedAt = now;

  return {
    text: `Created task [${id}] "${params.name}" in project "${project.name}"`,
  };
}

function handleTaskUpdate(data: PMData, params: PMParams, ctx: PMContext): { text: string } {
  if (!params.task_id) throw new Error("task_id is required for task_update");

  const task = data.tasks[params.task_id];
  if (!task) throw new Error(`Task not found: ${params.task_id}`);

  const project = data.projects[task.projectId];
  if (!project || !canAccess(project, ctx.conversationId)) {
    throw new Error("Access denied to this task");
  }

  const changes: string[] = [];
  if (params.status !== undefined && params.status !== task.status) {
    changes.push(`status: ${task.status} → ${params.status}`);
    task.status = params.status;
  }
  if (params.description !== undefined) {
    task.description = params.description;
    changes.push("description updated");
  }
  if (params.assignee_user_id !== undefined) {
    changes.push(`assignee: ${task.assigneeUserId ?? "none"} → ${params.assignee_user_id}`);
    task.assigneeUserId = params.assignee_user_id;
  }
  if (params.assignee_conversation_id !== undefined) {
    task.assigneeConversationId = params.assignee_conversation_id;
    changes.push("assignee_conversation_id updated");
  }
  if (params.due_date !== undefined) {
    changes.push(`due_date: ${task.dueDate ?? "none"} → ${params.due_date}`);
    task.dueDate = params.due_date;
  }

  task.updatedAt = Date.now();
  project.updatedAt = task.updatedAt;

  const noteStr = params.note ? ` Note: ${params.note}` : "";
  return {
    text:
      changes.length > 0
        ? `Updated task [${task.id}]: ${changes.join(", ")}.${noteStr}`
        : `No changes made to task [${task.id}].${noteStr}`,
  };
}

function handleTaskList(data: PMData, params: PMParams, ctx: PMContext): { text: string } {
  let tasks = Object.values(data.tasks);

  if (params.project_id) {
    const project = data.projects[params.project_id];
    if (!project) throw new Error(`Project not found: ${params.project_id}`);
    if (!canAccess(project, ctx.conversationId)) throw new Error("Access denied");
    tasks = tasks.filter((t) => t.projectId === params.project_id);
  } else {
    // Filter to tasks in visible projects
    const visibleProjectIds = new Set(
      Object.values(data.projects)
        .filter((p) => canAccess(p, ctx.conversationId))
        .map((p) => p.id),
    );
    tasks = tasks.filter((t) => visibleProjectIds.has(t.projectId));
  }

  if (params.filter_status) {
    tasks = tasks.filter((t) => t.status === params.filter_status);
  }
  if (params.filter_due_before) {
    tasks = tasks.filter((t) => t.dueDate && t.dueDate <= params.filter_due_before!);
  }

  if (tasks.length === 0) return { text: "No tasks found." };

  const lines = tasks.map((t) => {
    const project = data.projects[t.projectId];
    const projLabel = project ? ` [${project.name}]` : "";
    return `  ${formatTask(t)}${projLabel}`;
  });

  return { text: `Tasks (${tasks.length}):\n${lines.join("\n")}` };
}

function handleTaskGet(data: PMData, params: PMParams, ctx: PMContext): { text: string } {
  if (!params.task_id) throw new Error("task_id is required for task_get");

  const task = data.tasks[params.task_id];
  if (!task) throw new Error(`Task not found: ${params.task_id}`);

  const project = data.projects[task.projectId];
  if (!project || !canAccess(project, ctx.conversationId)) {
    throw new Error("Access denied to this task");
  }

  const reminders = Object.values(data.reminders).filter((r) => r.taskId === task.id);

  const lines = [
    `Task: ${task.title} [${task.id}]`,
    `Project: ${project.name} [${project.id}]`,
    `Status: ${task.status}`,
    task.description ? `Description: ${task.description}` : "",
    task.dueDate ? `Due: ${task.dueDate}` : "",
    task.assigneeUserId ? `Assignee: ${task.assigneeUserId}` : "",
    task.assigneeConversationId ? `Assignee DM: ${task.assigneeConversationId}` : "",
    `Created: ${new Date(task.createdAt).toISOString()}`,
    `Updated: ${new Date(task.updatedAt).toISOString()}`,
    reminders.length > 0
      ? `Reminders (${reminders.length}):\n${reminders.map((r) => `  [${r.id}] ${r.cron} (${r.timezone}) → ${r.targetConversationId}`).join("\n")}`
      : "",
  ].filter(Boolean);

  return { text: lines.join("\n") };
}

async function handleReminderSet(
  data: PMData,
  params: PMParams,
  ctx: PMContext,
  eventsDir: string,
): Promise<{ text: string }> {
  if (!params.cron) throw new Error("cron is required for reminder_set");
  if (!params.timezone) throw new Error("timezone is required for reminder_set");
  if (!params.task_id && !params.project_id) {
    throw new Error("task_id or project_id is required for reminder_set");
  }

  const task = params.task_id ? data.tasks[params.task_id] : undefined;
  const project = params.project_id
    ? data.projects[params.project_id]
    : task
      ? data.projects[task.projectId]
      : undefined;

  if (!project) throw new Error("Project not found");
  if (!canAccess(project, ctx.conversationId)) throw new Error("Access denied");
  if (task && task.projectId !== project.id) throw new Error("Task does not belong to project");

  const resultLines: string[] = [];

  async function createReminder(
    targetConversationId: string,
    targetConversationKind: "direct" | "shared",
    targetUserId: string,
    labelSuffix: string,
  ): Promise<void> {
    const id = `rem-${shortId()}`;
    const eventFilename = `pm-reminder-${id}-${Date.now()}.json`;
    const reminderLabel = params.label + labelSuffix;

    const eventPayload: EventPayload = {
      type: "periodic",
      platform: ctx.platform,
      conversationId: targetConversationId,
      conversationKind: targetConversationKind,
      userId: targetUserId,
      text: buildReminderText(reminderLabel, project, task),
      schedule: params.cron!,
      timezone: params.timezone!,
    };

    await writeEventFile(eventsDir, eventFilename, eventPayload);
    log.logInfo(`PM: wrote reminder event file ${eventFilename} → ${targetConversationId}`);

    data.reminders[id] = {
      id,
      taskId: task?.id,
      projectId: project!.id,
      cron: params.cron!,
      timezone: params.timezone!,
      targetConversationId,
      targetConversationKind,
      targetPlatform: ctx.platform,
      targetUserId,
      eventFilename,
      createdAt: Date.now(),
    };

    resultLines.push(
      `Created reminder [${id}] for ${targetConversationId} (${params.cron} ${params.timezone})`,
    );
  }

  // Primary target: explicit override or current conversation
  const primaryTarget = params.target_conversation_id ?? ctx.conversationId;
  const primaryKind =
    params.target_conversation_kind ??
    (primaryTarget === ctx.conversationId ? ctx.conversationKind : "shared");
  await createReminder(primaryTarget, primaryKind, ctx.userId, "");

  // If task has an assignee DM and no explicit target was provided, also create a DM reminder
  if (!params.target_conversation_id && task?.assigneeConversationId && task.assigneeUserId) {
    await createReminder(task.assigneeConversationId, "direct", task.assigneeUserId, " (DM)");
  }

  return { text: resultLines.join("\n") };
}

function handleReminderList(data: PMData, params: PMParams, ctx: PMContext): { text: string } {
  let reminders = Object.values(data.reminders);

  if (params.project_id) {
    reminders = reminders.filter((r) => r.projectId === params.project_id);
  } else if (params.task_id) {
    reminders = reminders.filter((r) => r.taskId === params.task_id);
  } else {
    // Filter to reminders for visible projects
    const visibleProjectIds = new Set(
      Object.values(data.projects)
        .filter((p) => canAccess(p, ctx.conversationId))
        .map((p) => p.id),
    );
    reminders = reminders.filter((r) => r.projectId && visibleProjectIds.has(r.projectId));
  }

  if (reminders.length === 0) return { text: "No reminders found." };

  const lines = reminders.map((r) => {
    const task = r.taskId ? data.tasks[r.taskId] : undefined;
    const project = r.projectId ? data.projects[r.projectId] : undefined;
    const scope = task ? `task "${task.title}"` : project ? `project "${project.name}"` : "?";
    return `[${r.id}] ${r.cron} (${r.timezone}) → ${r.targetConversationId} | ${scope}`;
  });

  return { text: `Reminders (${reminders.length}):\n${lines.join("\n")}` };
}

async function handleReminderDelete(
  data: PMData,
  params: PMParams,
  eventsDir: string,
): Promise<{ text: string }> {
  if (!params.reminder_id) throw new Error("reminder_id is required for reminder_delete");

  const reminder = data.reminders[params.reminder_id];
  if (!reminder) throw new Error(`Reminder not found: ${params.reminder_id}`);

  if (reminder.eventFilename) {
    await deleteEventFile(eventsDir, reminder.eventFilename);
    log.logInfo(`PM: deleted event file ${reminder.eventFilename}`);
  }

  delete data.reminders[params.reminder_id];

  return { text: `Deleted reminder [${params.reminder_id}]` };
}

function handleStatusReport(data: PMData, ctx: PMContext): { text: string } {
  const visibleProjects = Object.values(data.projects).filter((p) =>
    canAccess(p, ctx.conversationId),
  );

  if (visibleProjects.length === 0) return { text: "No projects found." };

  const sections: string[] = ["## PM Status Report", ""];

  for (const project of visibleProjects.filter((p) => p.status === "active")) {
    const tasks = tasksForProject(data, project.id);
    const blocked = tasks.filter((t) => t.status === "blocked");
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    const todo = tasks.filter((t) => t.status === "todo");
    const done = tasks.filter((t) => t.status === "done");

    sections.push(`### ${project.name} [${project.id}]`);
    if (project.description) sections.push(project.description);
    sections.push(
      `Progress: ${done.length}/${tasks.length} done | ${inProgress.length} in progress | ${blocked.length} blocked`,
    );

    if (blocked.length > 0) {
      sections.push("**Blocked:**");
      for (const t of blocked) sections.push(`  - ${formatTask(t)}`);
    }
    if (inProgress.length > 0) {
      sections.push("**In Progress:**");
      for (const t of inProgress) sections.push(`  - ${formatTask(t)}`);
    }
    if (todo.length > 0) {
      sections.push("**Todo:**");
      for (const t of todo) sections.push(`  - ${formatTask(t)}`);
    }
    sections.push("");
  }

  return { text: sections.join("\n") };
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createPMTool(workspaceDir: string): {
  tool: AgentTool<typeof pmSchema>;
  setPMContext: (context: PMContext) => void;
} {
  const pmDir = join(workspaceDir, "pm");
  const eventsDir = join(workspaceDir, "events");
  let pmContext: PMContext | null = null;

  const tool: AgentTool<typeof pmSchema> = {
    name: "pm",
    label: "pm",
    description:
      "Project management: create/list/get projects and tasks, track status, set periodic reminders to any channel or DM. Data persists across sessions in the workspace.",
    parameters: pmSchema,
    execute: async (_toolCallId: string, params: PMParams) => {
      if (!pmContext) throw new Error("PM context not configured");

      const ctx = pmContext;
      const data = await loadData(pmDir);
      let result: { text: string };

      switch (params.action) {
        case "project_create":
          result = handleProjectCreate(data, params, ctx);
          break;
        case "project_list":
          result = handleProjectList(data, ctx);
          break;
        case "project_get":
          result = handleProjectGet(data, params, ctx);
          break;
        case "task_create":
          result = handleTaskCreate(data, params, ctx);
          break;
        case "task_update":
          result = handleTaskUpdate(data, params, ctx);
          break;
        case "task_list":
          result = handleTaskList(data, params, ctx);
          break;
        case "task_get":
          result = handleTaskGet(data, params, ctx);
          break;
        case "reminder_set":
          result = await handleReminderSet(data, params, ctx, eventsDir);
          break;
        case "reminder_list":
          result = handleReminderList(data, params, ctx);
          break;
        case "reminder_delete":
          result = await handleReminderDelete(data, params, eventsDir);
          break;
        case "status_report":
          result = handleStatusReport(data, ctx);
          break;
        default:
          throw new Error(`Unknown PM action: ${params.action}`);
      }

      await saveData(pmDir, data);

      return { content: [{ type: "text", text: result.text }], details: undefined };
    },
  };

  return {
    tool,
    setPMContext: (context: PMContext) => {
      pmContext = context;
    },
  };
}
