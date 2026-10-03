#!/usr/bin/env node
// Development check: parses imported events with the installed bb server's own
// stored-event parser, so a bb update that changes the event contract shows
// up before an import does.
//
//   node scripts/check-events.mjs <bb.db> [thread-id ...]
//
// With no thread IDs, every thread that has a thread/started event (the
// marker this importer writes first) is checked. The database is opened
// read-only. BB_APP_DIST overrides the bb server dist directory.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const dist = process.env.BB_APP_DIST
  ?? "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist";
const [dbPath, ...threadIds] = process.argv.slice(2);
if (!dbPath) {
  console.error("Usage: node scripts/check-events.mjs <bb.db> [thread-id ...]");
  process.exit(2);
}
if (!existsSync(join(dist, "start-server.js"))) {
  console.error(`bb server not found at ${dist}; set BB_APP_DIST`);
  process.exit(2);
}

// The parser is module-private, so load a copy of the server bundle that also
// exports it. Loading the module defines code only; it never starts a server.
const work = mkdtempSync(join(tmpdir(), "bb-event-check-"));
mkdirSync(join(work, "dist"));
for (const entry of readdirSync(dist)) {
  if (entry !== "start-server.js") symlinkSync(join(dist, entry), join(work, "dist", entry));
}
symlinkSync(dirname(dirname(dirname(dist))), join(work, "node_modules"));
writeFileSync(
  join(work, "dist", "start-server.mjs"),
  `${readFileSync(join(dist, "start-server.js"), "utf8")}\nexport { parseThreadEventRow as __parse, init_stored_thread_event as __init };\n`,
);
const server = await import(pathToFileURL(join(work, "dist", "start-server.mjs")).href);
server.__init();

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const where = threadIds.length > 0
  ? `thread_id IN (${threadIds.map(() => "?").join(", ")})`
  : "thread_id IN (SELECT thread_id FROM events WHERE type = 'thread/started')";
const rows = db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY thread_id, sequence`).all(...threadIds);
db.close();

const failures = new Map();
for (const row of rows) {
  try {
    server.__parse({
      id: row.id,
      scope: row.scope_kind === "turn" ? { kind: "turn", turnId: row.turn_id } : { kind: "thread" },
      threadId: row.thread_id,
      seq: row.sequence,
      type: row.type,
      data: JSON.parse(row.data),
      createdAt: row.created_at,
    });
  } catch (error) {
    const key = row.item_kind ? `${row.type}:${row.item_kind}` : row.type;
    const list = failures.get(key) ?? [];
    list.push(`${row.thread_id}#${row.sequence}: ${error.issues ? JSON.stringify(error.issues) : error.message}`);
    failures.set(key, list);
  }
}
const failed = [...failures.values()].reduce((sum, list) => sum + list.length, 0);
console.log(`${rows.length} events checked, ${rows.length - failed} parsed, ${failed} rejected`);
for (const [key, list] of failures) console.log(`  ${key}: ${list.length} rejected, first: ${list[0].slice(0, 400)}`);
process.exit(failed > 0 ? 1 : 0);

