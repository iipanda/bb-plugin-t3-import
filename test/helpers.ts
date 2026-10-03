import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ImporterDeps, LedgerEntry } from "../src/importer.ts";
import { projectSlug } from "../src/claude-session.ts";

const fixtures = join(import.meta.dirname, "fixtures");
export const HOST_ID = "host_test";

export interface Fixture {
  dir: string;
  repo: string;
  t3Path: string;
  bbPath: string;
  claudeHome: string;
  t3: Database.Database;
  ledger: Map<string, LedgerEntry>;
  createdProjects: string[];
  deps: ImporterDeps;
}

export function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "t3-import-test-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });

  const t3Path = join(dir, "state.sqlite");
  const t3 = new Database(t3Path);
  t3.exec(readFileSync(join(fixtures, "t3-schema.sql"), "utf8"));
  t3.prepare(`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('p1', 'repo', ?, '[]', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run(repo);

  const bbPath = join(dir, "bb.db");
  const bb = new Database(bbPath);
  bb.exec(readFileSync(join(fixtures, "bb-0.45-schema.sql"), "utf8"));
  bb.prepare("INSERT INTO hosts(id, name, type, created_at, updated_at) VALUES (?, 'test', 'persistent', 0, 0)").run(HOST_ID);
  bb.close();

  const claudeHome = join(dir, "claude");
  mkdirSync(join(claudeHome, "projects"), { recursive: true });

  const ledger = new Map<string, LedgerEntry>();
  const createdProjects: string[] = [];
  const deps: ImporterDeps = {
    t3DbPath: t3Path,
    bbDbPath: bbPath,
    claudeHome,
    backupDir: join(dir, "backups"),
    hostId: HOST_ID,
    listProjects: async () => {
      const db = new Database(bbPath, { readonly: true });
      const rows = db.prepare(`SELECT p.id, p.name, s.host_id AS hostId, s.path FROM projects p
        LEFT JOIN project_sources s ON s.project_id = p.id WHERE p.deleted_at IS NULL`).all() as { id: string; name: string; hostId: string | null; path: string | null }[];
      db.close();
      const byId = new Map<string, { id: string; name: string; sources: { hostId: string; path: string }[] }>();
      for (const row of rows) {
        const project = byId.get(row.id) ?? { id: row.id, name: row.name, sources: [] };
        if (row.hostId && row.path) project.sources.push({ hostId: row.hostId, path: row.path });
        byId.set(row.id, project);
      }
      return [...byId.values()];
    },
    createProject: async (name, path) => {
      const id = `proj_${createdProjects.length + 1}`;
      const db = new Database(bbPath);
      db.prepare("INSERT INTO projects(id, name, created_at, updated_at, sort_key) VALUES (?, ?, 0, 0, ?)").run(id, name, `a${createdProjects.length}`);
      db.prepare(`INSERT INTO project_sources(id, project_id, host_id, type, path, is_default, created_at, updated_at)
        VALUES (?, ?, ?, 'local_path', ?, 1, 0, 0)`).run(`src_${id}`, id, HOST_ID, path);
      db.close();
      createdProjects.push(id);
      return { id, name, sources: [{ hostId: HOST_ID, path }] };
    },
    ledger: {
      get: async (id) => ledger.get(id),
      set: async (id, entry) => { ledger.set(id, entry); },
    },
  };
  return { dir, repo, t3Path, bbPath, claudeHome, t3, ledger, createdProjects, deps };
}

export interface ThreadSeed {
  id: string;
  title?: string;
  settled?: boolean;
  archived?: boolean;
  provider?: "claudeAgent" | "codex" | null;
  sessionId?: string | null;
}

export function seedThread(f: Fixture, seed: ThreadSeed): void {
  const provider = seed.provider === undefined ? "claudeAgent" : seed.provider;
  f.t3.prepare(`INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at, archived_at,
      settled_override, settled_at, model_selection_json)
    VALUES (?, 'p1', ?, '2026-09-20T10:00:00.000Z', '2026-09-21T10:00:00.000Z', ?, ?, ?, ?)`).run(
    seed.id, seed.title ?? seed.id, seed.archived ? "2026-09-22T00:00:00.000Z" : null,
    seed.settled ? "settled" : null, seed.settled ? "2026-09-21T11:00:00.000Z" : null,
    JSON.stringify({ instanceId: provider ?? "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] }),
  );
  if (provider) {
    f.t3.prepare(`INSERT INTO projection_thread_sessions(thread_id, status, provider_name, updated_at) VALUES (?, 'ready', ?, '2026-09-21T10:00:00.000Z')`)
      .run(seed.id, provider);
  }
  const sessionId = seed.sessionId === undefined ? `sess-${seed.id}` : seed.sessionId;
  if (sessionId !== null) {
    const cursor = provider === "codex" ? { threadId: sessionId } : { threadId: seed.id, resume: sessionId };
    f.t3.prepare(`INSERT INTO provider_session_runtime(thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json)
      VALUES (?, ?, ?, 'stopped', '2026-09-21T10:00:00.000Z', ?)`).run(seed.id, provider ?? "claudeAgent", provider ?? "claudeAgent", JSON.stringify(cursor));
  }
}

let messageCount = 0;
export function message(f: Fixture, threadId: string, role: string, text: string, at: string, turnId: string | null = null, attachments: unknown[] = []): void {
  f.t3.prepare(`INSERT INTO projection_thread_messages(message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at, attachments_json)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(`m${++messageCount}`, threadId, turnId, role, text, at, at, JSON.stringify(attachments));
}

let activityCount = 0;
export function activity(f: Fixture, threadId: string, kind: string, payload: unknown, at: string, turnId: string | null = null): void {
  activityCount++;
  f.t3.prepare(`INSERT INTO projection_thread_activities(activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
    VALUES (?, ?, ?, 'tool', ?, '', ?, ?, ?)`).run(`a${activityCount}`, threadId, turnId, kind, JSON.stringify(payload), at, activityCount);
}

export function turn(f: Fixture, threadId: string, turnId: string, state: string): void {
  f.t3.prepare(`INSERT INTO projection_turns(thread_id, turn_id, state, requested_at, checkpoint_files_json) VALUES (?, ?, ?, '2026-09-20T10:00:00.000Z', '[]')`)
    .run(threadId, turnId, state);
}

/** Writes a Claude Code transcript for `sessionId` under the project directory of `cwd`. */
export function claudeSession(f: Fixture, sessionId: string, cwd: string, withSidecar = false): string {
  const dir = join(f.claudeHome, "projects", projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = [
    { type: "user", uuid: "u1", sessionId, message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId, message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    { type: "last-prompt", lastPrompt: "hi", sessionId },
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  if (withSidecar) {
    mkdirSync(join(dir, sessionId, "subagents"), { recursive: true });
    writeFileSync(join(dir, sessionId, "subagents", "agent-1.jsonl"), `${JSON.stringify({ type: "user", sessionId, isSidechain: true })}\n`);
  }
  return path;
}
