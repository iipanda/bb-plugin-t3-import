// Direct writes to bb.db. bb has no API that creates a thread with existing
// history, so imported threads, their environment, and their events are
// inserted the way bb records them itself. The schema is checked before every
// run, and every thread is written in one transaction.
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { History, ImportEvent } from "./convert.ts";
import { newId } from "./convert.ts";

export const ENVIRONMENT_PROVIDER_ID = "project-checkout";
export const ENVIRONMENT_PROVIDER_PLUGIN_ID = "environment-project-checkout";
const BACKUPS_KEPT = 3;

export interface ImportThreadArgs {
  projectId: string;
  hostId: string;
  environmentPath: string;
  providerId: "claude-code" | "codex";
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs: number | null;
  history: History;
}

export class BbStore {
  readonly db: Database.Database;

  constructor(path: string, writable = false) {
    this.db = new Database(path, { readonly: !writable, fileMustExist: true, timeout: 30_000 });
    this.db.pragma("busy_timeout = 30000");
    this.assertSchema();
  }

  close(): void {
    this.db.close();
  }

  private assertSchema(): void {
    const required: Record<string, string[]> = {
      threads: [
        "id", "project_id", "environment_id", "provider_id", "title", "title_fallback", "status",
        "archived_at", "deleted_at", "last_read_at", "latest_attention_at", "created_at", "updated_at", "visibility",
      ],
      environments: [
        "id", "project_id", "host_id", "path", "is_git_repo", "is_worktree", "status", "created_at", "updated_at",
        "environment_provider_id", "environment_provider_plugin_id", "environment_provider_selection",
        "environment_provider_instance_key", "provider_owns_path",
      ],
      events: [
        "id", "thread_id", "environment_id", "scope_kind", "turn_id", "provider_thread_id", "sequence",
        "type", "item_id", "item_kind", "data", "created_at", "parent_tool_call_id",
      ],
      thread_search_segments: ["id", "thread_id", "source_kind", "source_key", "source_seq", "text", "created_at", "updated_at"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const actual = new Set((this.db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name));
      for (const column of columns) {
        if (!actual.has(column)) throw new Error(`Unsupported bb database: ${table}.${column} is missing`);
      }
    }
  }

  /** True when the bb thread exists and has not been deleted. */
  threadAlive(threadId: string): boolean {
    return this.db.prepare("SELECT 1 FROM threads WHERE id = ? AND deleted_at IS NULL").get(threadId) !== undefined;
  }

  /** The bb thread that already claims a provider session, if any. */
  sessionClaimant(providerThreadId: string): string | null {
    const row = this.db.prepare(`
      SELECT e.thread_id FROM events e JOIN threads t ON t.id = e.thread_id
      WHERE e.type = 'thread/identity' AND e.provider_thread_id = ? AND t.deleted_at IS NULL LIMIT 1
    `).get(providerThreadId) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  }

  async backup(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `bb-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.sqlite`);
    await this.db.backup(path);
    const backups = (await readdir(dir)).filter((name) => name.startsWith("bb-") && name.endsWith(".sqlite")).sort();
    await Promise.all(backups.slice(0, -BACKUPS_KEPT).map((name) => rm(join(dir, name), { force: true })));
    return path;
  }

  importThread(args: ImportThreadArgs): string {
    if (!existsSync(args.environmentPath)) throw new Error(`Project path does not exist: ${args.environmentPath}`);
    const threadId = newId("thr");
    const now = Date.now();
    const write = this.db.transaction(() => {
      const environmentId = this.ensureEnvironment(args.projectId, args.hostId, args.environmentPath, threadId, now);
      const firstUser = firstUserText(args.history.events);
      this.db.prepare(`
        INSERT INTO threads(id, project_id, environment_id, provider_id, status, title, title_fallback, archived_at,
          last_read_at, latest_attention_at, created_at, updated_at, visibility)
        VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, 'visible')
      `).run(
        threadId, args.projectId, environmentId, args.providerId, args.title.trim() || null,
        firstUser ? firstUser.slice(0, 80) : null, args.archivedAtMs,
        args.updatedAtMs, args.updatedAtMs, args.createdAtMs, args.updatedAtMs,
      );
      const insertEvent = this.db.prepare(`
        INSERT INTO events(id, thread_id, environment_id, scope_kind, turn_id, provider_thread_id,
          sequence, type, item_id, item_kind, data, created_at, parent_tool_call_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `);
      const insertSegment = this.db.prepare(`
        INSERT INTO thread_search_segments(id, thread_id, source_kind, source_key, source_seq, text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const title = args.title.trim();
      if (title) insertSegment.run(`${threadId}:title:title`, threadId, "title", "title", null, title, now, now);
      for (const event of args.history.events) {
        insertEvent.run(
          event.id, threadId, environmentId, event.scopeKind, event.turnId, event.providerThreadId,
          event.sequence, event.type, event.itemId, event.itemKind, event.data, event.createdAt,
        );
        const segment = searchSegment(event);
        if (segment) {
          insertSegment.run(
            `${threadId}:${segment.kind}:event:${event.sequence}`, threadId, segment.kind,
            `event:${event.sequence}`, event.sequence, segment.text, event.createdAt, event.createdAt,
          );
        }
      }
    });
    write.immediate();
    return threadId;
  }

  /** Reuses the project's ready environment at this path, or records a project checkout for it. */
  private ensureEnvironment(projectId: string, hostId: string, path: string, threadId: string, now: number): string {
    const existing = this.db.prepare(`
      SELECT id, status FROM environments WHERE project_id = ? AND host_id = ? AND path = ? LIMIT 1
    `).get(projectId, hostId, path) as { id: string; status: string } | undefined;
    if (existing) {
      if (existing.status !== "ready") throw new Error(`bb environment ${existing.id} for ${path} is ${existing.status}, not ready`);
      return existing.id;
    }
    const environmentId = newId("env");
    this.db.prepare(`
      INSERT INTO environments(id, project_id, host_id, path, is_git_repo, is_worktree, status,
        environment_provider_id, environment_provider_plugin_id, environment_provider_selection,
        environment_provider_instance_key, provider_owns_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'ready', ?, ?, ?, ?, 0, ?, ?)
    `).run(
      environmentId, projectId, hostId, path, existsSync(join(path, ".git")) ? 1 : 0,
      ENVIRONMENT_PROVIDER_ID, ENVIRONMENT_PROVIDER_PLUGIN_ID,
      JSON.stringify({ machine: { type: "existing", hostId }, inputs: null }),
      threadId, now, now,
    );
    return environmentId;
  }
}

function firstUserText(events: ImportEvent[]): string | null {
  for (const event of events) {
    if (event.type !== "client/turn/requested") continue;
    const segment = searchSegment(event);
    if (segment) return segment.text.replace(/\s+/g, " ").trim();
  }
  return null;
}

function searchSegment(event: ImportEvent): { kind: string; text: string } | null {
  if (event.type !== "client/turn/requested" && event.type !== "item/completed") return null;
  const data = JSON.parse(event.data) as Record<string, unknown>;
  if (event.type === "client/turn/requested") {
    const input = Array.isArray(data.input) ? data.input as Record<string, unknown>[] : [];
    const text = input.map((part) => typeof part.text === "string" ? part.text : "").join("");
    return text ? { kind: "user_message", text } : null;
  }
  const item = typeof data.item === "object" && data.item !== null ? data.item as Record<string, unknown> : {};
  if (item.type !== "agentMessage" && item.type !== "plan") return null;
  const text = typeof item.text === "string" ? item.text : "";
  return text ? { kind: "assistant_message", text } : null;
}
