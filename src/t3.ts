// Read-only access to T3 Code's local state database
// (~/.t3/userdata/state.sqlite). Only the projection_* tables are read; T3's
// event log and its own runtime state are never touched.
import Database from "better-sqlite3";

export type T3Provider = "claudeAgent" | "codex";

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
}

export interface T3Thread {
  id: string;
  projectId: string;
  projectTitle: string;
  workspaceRoot: string;
  title: string;
  worktreePath: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs: number | null;
  settled: boolean;
  provider: T3Provider | null;
  /** Claude Code session ID, or Codex thread ID, that T3 resumes. */
  sessionId: string | null;
  model: string | null;
  effort: string | null;
}

export interface T3Attachment {
  name: string;
  mimeType: string | null;
}

export type T3Entry =
  | { kind: "user"; at: number; text: string; attachments: T3Attachment[] }
  | { kind: "assistant"; at: number; text: string; turnId: string | null }
  | { kind: "reasoning"; at: number; text: string; turnId: string | null }
  | {
      kind: "tool";
      at: number;
      turnId: string | null;
      itemType: string;
      toolName: string;
      input: Record<string, unknown>;
      status: "completed" | "failed";
      result: unknown;
      error: string | null;
    }
  | { kind: "plan"; at: number; text: string; turnId: string | null }
  | { kind: "compaction"; at: number; turnId: string | null };

export interface T3Timeline {
  entries: T3Entry[];
  /** T3 turn state keyed by T3 turn ID: completed, interrupted, error, running. */
  turnStates: Map<string, string>;
}

interface ThreadRow {
  thread_id: string;
  project_id: string;
  project_title: string;
  workspace_root: string;
  title: string;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  settled_override: string | null;
  settled_at: string | null;
  unsettled_at: string | null;
  model_selection_json: string | null;
  session_provider: string | null;
  runtime_provider: string | null;
  resume_cursor_json: string | null;
}

export class T3Source {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true, fileMustExist: true, timeout: 30_000 });
    this.assertSchema();
  }

  close(): void {
    this.db.close();
  }

  private assertSchema(): void {
    const required: Record<string, string[]> = {
      projection_projects: ["project_id", "title", "workspace_root", "deleted_at"],
      projection_threads: [
        "thread_id", "project_id", "title", "worktree_path", "created_at", "updated_at",
        "deleted_at", "archived_at", "settled_override", "settled_at", "unsettled_at", "model_selection_json",
      ],
      projection_thread_messages: ["message_id", "thread_id", "turn_id", "role", "text", "created_at", "attachments_json"],
      projection_thread_activities: ["activity_id", "thread_id", "turn_id", "kind", "payload_json", "created_at", "sequence"],
      projection_thread_sessions: ["thread_id", "provider_name"],
      provider_session_runtime: ["thread_id", "provider_name", "resume_cursor_json"],
      projection_turns: ["thread_id", "turn_id", "state"],
      projection_thread_proposed_plans: ["plan_id", "thread_id", "turn_id", "plan_markdown", "created_at"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const actual = new Set((this.db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name));
      for (const column of columns) {
        if (!actual.has(column)) throw new Error(`Unsupported T3 Code database: ${table}.${column} is missing`);
      }
    }
  }

  projects(): T3Project[] {
    return (this.db.prepare(`
      SELECT project_id AS id, title, workspace_root AS workspaceRoot
      FROM projection_projects WHERE deleted_at IS NULL ORDER BY title
    `).all() as T3Project[]);
  }

  /** Every thread that T3 has not deleted, in its live projects. */
  threads(): T3Thread[] {
    const rows = this.db.prepare(`
      SELECT t.thread_id, t.project_id, p.title AS project_title, p.workspace_root, t.title,
        t.worktree_path, t.created_at, t.updated_at, t.archived_at, t.settled_override,
        t.settled_at, t.unsettled_at, t.model_selection_json,
        s.provider_name AS session_provider, r.provider_name AS runtime_provider, r.resume_cursor_json
      FROM projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
      WHERE t.deleted_at IS NULL
      ORDER BY p.title, t.created_at
    `).all() as ThreadRow[];
    return rows.map(toThread);
  }

  timeline(threadId: string): T3Timeline {
    const entries: { entry: T3Entry; order: number }[] = [];
    let order = 0;
    const push = (entry: T3Entry) => entries.push({ entry, order: order++ });

    const messages = this.db.prepare(`
      SELECT role, turn_id, text, created_at, attachments_json
      FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at, message_id
    `).all(threadId) as { role: string; turn_id: string | null; text: string; created_at: string; attachments_json: string | null }[];
    for (const message of messages) {
      const at = ms(message.created_at);
      if (message.role === "user") {
        push({ kind: "user", at, text: message.text, attachments: attachments(message.attachments_json) });
      } else if ((message.role === "assistant" || message.role === "reasoning") && message.text.trim() !== "") {
        push({ kind: message.role, at, text: message.text, turnId: message.turn_id });
      }
    }

    const activities = this.db.prepare(`
      SELECT turn_id, kind, payload_json, created_at
      FROM projection_thread_activities
      WHERE thread_id = ? AND kind IN ('tool.started', 'tool.completed', 'tool.denied', 'context-compaction')
      ORDER BY sequence, created_at
    `).all(threadId) as { turn_id: string | null; kind: string; payload_json: string; created_at: string }[];
    const startedAt = new Map<string, number>();
    for (const activity of activities) {
      const payload = record(parseJson(activity.payload_json));
      const callId = string(payload.toolCallId) ?? string(payload.toolUseId);
      if (activity.kind === "tool.started" && callId && !startedAt.has(callId)) {
        startedAt.set(callId, ms(activity.created_at));
      }
    }
    for (const activity of activities) {
      const payload = record(parseJson(activity.payload_json));
      const callId = string(payload.toolCallId) ?? string(payload.toolUseId);
      const at = (callId ? startedAt.get(callId) : undefined) ?? ms(activity.created_at);
      if (activity.kind === "tool.completed") {
        const data = record(payload.data);
        push({
          kind: "tool", at, turnId: activity.turn_id,
          itemType: string(payload.itemType) ?? "tool",
          toolName: string(data.toolName) ?? string(payload.title) ?? "Tool",
          input: record(data.input),
          status: payload.status === "failed" ? "failed" : "completed",
          result: data.result ?? null,
          error: null,
        });
      } else if (activity.kind === "tool.denied") {
        push({
          kind: "tool", at, turnId: activity.turn_id, itemType: "denied",
          toolName: string(payload.toolName) ?? "Tool", input: {}, status: "failed", result: null,
          error: string(payload.detail) ?? "Denied",
        });
      } else if (activity.kind === "context-compaction") {
        push({ kind: "compaction", at, turnId: activity.turn_id });
      }
    }

    const plans = this.db.prepare(`
      SELECT turn_id, plan_markdown, created_at FROM projection_thread_proposed_plans
      WHERE thread_id = ? ORDER BY created_at
    `).all(threadId) as { turn_id: string | null; plan_markdown: string; created_at: string }[];
    for (const plan of plans) {
      if (plan.plan_markdown.trim() !== "") {
        push({ kind: "plan", at: ms(plan.created_at), text: plan.plan_markdown, turnId: plan.turn_id });
      }
    }

    // A user message opens its turn, so it sorts before anything else that
    // carries the same timestamp.
    entries.sort((a, b) => a.entry.at - b.entry.at
      || Number(b.entry.kind === "user") - Number(a.entry.kind === "user")
      || a.order - b.order);

    const turnStates = new Map<string, string>();
    const turns = this.db.prepare(`
      SELECT turn_id, state FROM projection_turns WHERE thread_id = ? AND turn_id IS NOT NULL
    `).all(threadId) as { turn_id: string; state: string }[];
    for (const turn of turns) turnStates.set(turn.turn_id, turn.state);

    return { entries: entries.map((item) => item.entry), turnStates };
  }
}

export function isSettled(row: { settledOverride: string | null; settledAt: string | null; unsettledAt: string | null }): boolean {
  if (row.settledOverride === "settled") return true;
  if (row.settledOverride !== null) return false;
  if (row.settledAt === null) return false;
  return row.unsettledAt === null || ms(row.settledAt) > ms(row.unsettledAt);
}

function toThread(row: ThreadRow): T3Thread {
  const selection = record(parseJson(row.model_selection_json));
  const cursor = record(parseJson(row.resume_cursor_json));
  const provider = providerOf(row.session_provider) ?? providerOf(row.runtime_provider) ?? providerOf(string(selection.instanceId) ?? null);
  const options = Array.isArray(selection.options) ? selection.options.map(record) : [];
  const effort = options.find((option) => option.id === "effort" || option.id === "reasoningEffort");
  return {
    id: row.thread_id,
    projectId: row.project_id,
    projectTitle: row.project_title,
    workspaceRoot: row.workspace_root,
    title: row.title,
    worktreePath: row.worktree_path,
    createdAtMs: ms(row.created_at),
    updatedAtMs: ms(row.updated_at),
    archivedAtMs: row.archived_at === null ? null : ms(row.archived_at),
    settled: isSettled({ settledOverride: row.settled_override, settledAt: row.settled_at, unsettledAt: row.unsettled_at }),
    provider,
    sessionId: provider === "codex" ? string(cursor.threadId) ?? null : string(cursor.resume) ?? null,
    model: string(selection.model) ?? null,
    effort: string(effort?.value) ?? null,
  };
}

function providerOf(value: string | null): T3Provider | null {
  return value === "claudeAgent" || value === "codex" ? value : null;
}

function attachments(json: string | null): T3Attachment[] {
  const value = parseJson(json);
  if (!Array.isArray(value)) return [];
  return value.map(record).map((item) => ({ name: string(item.name) ?? "attachment", mimeType: string(item.mimeType) ?? null }));
}

export function ms(iso: string): number {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) throw new Error(`Invalid T3 timestamp: ${iso}`);
  return value;
}

function parseJson(text: string | null): unknown {
  if (text === null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
