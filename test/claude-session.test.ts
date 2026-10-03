import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { copySession, findSession, projectSlug, rewriteTranscript } from "../src/claude-session.ts";
import { claudeSession, fixture } from "./helpers.ts";

test("matches Claude Code's project directory naming", () => {
  assert.equal(projectSlug("/Users/karol/Desktop/voxelhost-infrastructure"), "-Users-karol-Desktop-voxelhost-infrastructure");
  assert.equal(projectSlug("/Users/karol/.bb/workspaces/thr_ans8h3mzrb"), "-Users-karol--bb-workspaces-thr-ans8h3mzrb");
});

test("rewrites only lines that belong to the copied session", () => {
  const text = [
    JSON.stringify({ type: "user", sessionId: "old", uuid: "u1" }),
    JSON.stringify({ type: "user", sessionId: "other" }),
    "not json",
    "",
  ].join("\n");
  const lines = rewriteTranscript(text, "old", "new").split("\n");
  assert.equal(JSON.parse(lines[0]!).sessionId, "new");
  assert.equal(JSON.parse(lines[0]!).uuid, "u1");
  assert.equal(JSON.parse(lines[1]!).sessionId, "other");
  assert.equal(lines[2], "not json");
});

test("copies a session and its subagent transcripts without touching the original", async () => {
  const f = fixture();
  const original = claudeSession(f, "sess-a", f.repo, true);
  const before = readFileSync(original, "utf8");
  assert.equal(await findSession(f.claudeHome, "sess-a", [f.repo]), original);
  assert.equal(await findSession(f.claudeHome, "sess-a", ["/elsewhere"]), original, "falls back to scanning every project");
  assert.equal(await findSession(f.claudeHome, "missing", [f.repo]), null);

  const copy = await copySession({ claudeHome: f.claudeHome, sourcePath: original, sourceSessionId: "sess-a", targetCwd: f.repo });
  assert.notEqual(copy.sessionId, "sess-a");
  assert.equal(copy.transcriptPath, join(f.claudeHome, "projects", projectSlug(f.repo), `${copy.sessionId}.jsonl`));
  const copied = readFileSync(copy.transcriptPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(copied.every((line) => line.sessionId === copy.sessionId));
  assert.equal(copied.length, 3);
  const sidecar = join(f.claudeHome, "projects", projectSlug(f.repo), copy.sessionId, "subagents", "agent-1.jsonl");
  assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).sessionId, copy.sessionId);
  assert.equal(readFileSync(original, "utf8"), before);

  await copy.undo();
  assert.equal(existsSync(copy.transcriptPath), false);
  assert.equal(existsSync(join(f.claudeHome, "projects", projectSlug(f.repo), copy.sessionId)), false);
  assert.equal(readFileSync(original, "utf8"), before);
});
