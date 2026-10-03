import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { projectSlug } from "../src/claude-session.ts";
import { planImport, runImport, type ImportFilters } from "../src/importer.ts";
import { claudeSession, fixture, HOST_ID, message, seedThread, type Fixture } from "./helpers.ts";

const defaults: ImportFilters = { projects: [], threads: [], includeSettled: false, includeArchived: true, limit: null };

function seedThree(f: Fixture) {
  seedThread(f, { id: "open" , title: "Open work" });
  seedThread(f, { id: "done", title: "Settled work", settled: true });
  seedThread(f, { id: "old", title: "Archived work", archived: true, provider: "codex", sessionId: "codex-thread-1" });
  for (const id of ["open", "done", "old"]) {
    message(f, id, "user", `question for ${id}`, "2026-09-20T10:00:00.000Z");
    message(f, id, "assistant", `answer for ${id}`, "2026-09-20T10:00:05.000Z", "turn-1");
  }
  claudeSession(f, "sess-open", f.repo);
  claudeSession(f, "sess-done", f.repo);
}

test("preview leaves out settled threads and changes nothing", async () => {
  const f = fixture();
  seedThree(f);
  const plan = await planImport(f.deps, defaults, "copy");
  assert.deepEqual(plan.threads.map((thread) => thread.t3.id).sort(), ["old", "open"]);
  assert.deepEqual(plan.filtered, { settled: 1 });
  const open = plan.threads.find((thread) => thread.t3.id === "open")!;
  assert.equal(open.session.kind, "copy");
  assert.equal(open.providerId, "claude-code");
  assert.equal(open.bbProject.id, null);
  const old = plan.threads.find((thread) => thread.t3.id === "old")!;
  assert.deepEqual(old.session, { kind: "share", sessionId: "codex-thread-1" });
  assert.equal(old.providerId, "codex");
  assert.deepEqual(f.createdProjects, []);
  assert.equal(existsSync(f.deps.backupDir), false);
  assert.equal(readdirSync(join(f.claudeHome, "projects", projectSlug(f.repo))).length, 2);
});

test("filters by project, thread, settled, archived, and limit", async () => {
  const f = fixture();
  seedThree(f);
  const ids = async (filters: Partial<ImportFilters>) => (await planImport(f.deps, { ...defaults, ...filters }, "copy")).threads.map((thread) => thread.t3.id).sort();
  assert.deepEqual(await ids({ includeSettled: true }), ["done", "old", "open"]);
  assert.deepEqual(await ids({ includeArchived: false }), ["open"]);
  assert.deepEqual(await ids({ threads: ["done"] }), ["done"], "an explicitly selected thread is imported even when settled");
  assert.deepEqual(await ids({ projects: ["repo"] }), ["old", "open"]);
  assert.deepEqual(await ids({ projects: [f.repo] }), ["old", "open"]);
  assert.deepEqual(await ids({ projects: ["elsewhere"] }), []);
  assert.equal((await ids({ limit: 1 })).length, 1);
});

test("imports threads into one project checkout, resuming a copied session", async () => {
  const f = fixture();
  seedThree(f);
  const plan = await planImport(f.deps, defaults, "copy");
  const result = await runImport(f.deps, plan);
  assert.deepEqual(result.failed, []);
  assert.equal(result.imported.length, 2);
  assert.ok(result.backupPath && existsSync(result.backupPath));
  assert.deepEqual(f.createdProjects, ["proj_1"], "creates the bb project once");

  const db = new Database(f.bbPath, { readonly: true });
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  const environments = db.prepare("SELECT * FROM environments").all() as Record<string, unknown>[];
  assert.equal(environments.length, 1, "both threads share one environment");
  assert.equal(environments[0]!.path, f.repo);
  assert.equal(environments[0]!.status, "ready");
  assert.equal(environments[0]!.environment_provider_id, "project-checkout");
  assert.equal(environments[0]!.is_git_repo, 1);
  assert.equal(environments[0]!.host_id, HOST_ID);

  const open = result.imported.find((thread) => thread.t3ThreadId === "open")!;
  const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(open.bbThreadId) as Record<string, unknown>;
  assert.equal(row.provider_id, "claude-code");
  assert.equal(row.status, "idle");
  assert.equal(row.title, "Open work");
  assert.equal(row.title_fallback, "question for open");
  assert.equal(row.archived_at, null);
  assert.equal(row.created_at, Date.parse("2026-09-20T10:00:00.000Z"));
  const identity = db.prepare("SELECT provider_thread_id FROM events WHERE thread_id = ? AND type = 'thread/identity'").get(open.bbThreadId) as { provider_thread_id: string };
  assert.equal(identity.provider_thread_id, open.sessionId);
  assert.notEqual(open.sessionId, "sess-open");
  assert.ok(existsSync(join(f.claudeHome, "projects", projectSlug(f.repo), `${open.sessionId}.jsonl`)));
  const segments = db.prepare("SELECT source_kind, text FROM thread_search_segments WHERE thread_id = ? ORDER BY source_kind").all(open.bbThreadId);
  assert.deepEqual(segments, [
    { source_kind: "assistant_message", text: "answer for open" },
    { source_kind: "title", text: "Open work" },
    { source_kind: "user_message", text: "question for open" },
  ]);
  const fts = db.prepare("SELECT count(*) AS n FROM thread_search_segments_fts WHERE thread_search_segments_fts MATCH 'answer'").get() as { n: number };
  assert.equal(fts.n, 2, "search index triggers ran");

  const old = result.imported.find((thread) => thread.t3ThreadId === "old")!;
  const oldRow = db.prepare("SELECT provider_id, archived_at FROM threads WHERE id = ?").get(old.bbThreadId) as Record<string, unknown>;
  assert.equal(oldRow.provider_id, "codex");
  assert.equal(oldRow.archived_at, Date.parse("2026-09-22T00:00:00.000Z"));
  assert.equal(old.sessionId, "codex-thread-1");
  db.close();

  assert.deepEqual(f.ledger.get("open")?.bbThreadId, open.bbThreadId);
});

test("a second run skips threads it already imported", async () => {
  const f = fixture();
  seedThree(f);
  await runImport(f.deps, await planImport(f.deps, defaults, "copy"));
  const again = await planImport(f.deps, defaults, "copy");
  assert.ok(again.threads.every((thread) => thread.action === "skip" && /already imported/.test(thread.reason ?? "")));
  assert.equal(again.threads[0]!.bbProject.id, "proj_1", "finds the project it created");
  const rerun = await runImport(f.deps, again);
  assert.deepEqual(rerun.imported, []);
  assert.equal(rerun.backupPath, null, "no backup when nothing is written");
});

test("share mode resumes the T3 session itself and refuses a session another thread claims", async () => {
  const f = fixture();
  seedThree(f);
  const plan = await planImport(f.deps, { ...defaults, threads: ["open"] }, "share");
  assert.deepEqual(plan.threads[0]!.session, { kind: "share", sessionId: "sess-open" });
  const result = await runImport(f.deps, plan);
  assert.equal(result.imported[0]!.sessionId, "sess-open");
  assert.equal(readdirSync(join(f.claudeHome, "projects", projectSlug(f.repo))).length, 2, "no session copy");

  f.ledger.clear();
  const second = await planImport(f.deps, { ...defaults, threads: ["open"] }, "share");
  assert.equal(second.threads[0]!.session.kind, "none");
  assert.match(second.threads[0]!.warnings.join(" "), /already resumes this session/);
});

test("imports history only when the Claude session file is gone", async () => {
  const f = fixture();
  seedThread(f, { id: "lost", sessionId: "sess-lost" });
  message(f, "lost", "user", "hi", "2026-09-20T10:00:00.000Z");
  const plan = await planImport(f.deps, defaults, "copy");
  assert.equal(plan.threads[0]!.session.kind, "none");
  assert.match(plan.threads[0]!.warnings.join(" "), /session file is missing/);
  const result = await runImport(f.deps, plan);
  const db = new Database(f.bbPath, { readonly: true });
  const identities = db.prepare("SELECT count(*) AS n FROM events WHERE thread_id = ? AND type = 'thread/identity'").get(result.imported[0]!.bbThreadId) as { n: number };
  db.close();
  assert.equal(identities.n, 0);
});

test("a failed thread write removes its session copy and leaves bb unchanged", async () => {
  const f = fixture();
  seedThree(f);
  const plan = await planImport(f.deps, { ...defaults, threads: ["open"] }, "copy");
  rmSync(f.repo, { recursive: true });
  const before = readdirSync(join(f.claudeHome, "projects", projectSlug(f.repo))).sort();
  const result = await runImport(f.deps, plan);
  assert.equal(result.imported.length, 0);
  assert.match(result.failed[0]!.error, /Project path does not exist/);
  assert.deepEqual(readdirSync(join(f.claudeHome, "projects", projectSlug(f.repo))).sort(), before);
  const db = new Database(f.bbPath, { readonly: true });
  assert.equal((db.prepare("SELECT count(*) AS n FROM threads").get() as { n: number }).n, 0);
  db.close();
});
