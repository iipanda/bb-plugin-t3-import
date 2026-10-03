// Claude Code keeps each session at
// ~/.claude/projects/<cwd slug>/<session id>.jsonl, plus an optional
// <session id>/ directory for subagent transcripts. Copying a session gives
// the imported bb thread its own branch of the conversation, so continuing
// it in bb never changes the session T3 Code resumes.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Claude Code's project directory name for a working directory. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Finds a session transcript, preferring the directory of its original working directory. */
export async function findSession(claudeHome: string, sessionId: string, preferredCwds: string[]): Promise<string | null> {
  const projectsDir = join(claudeHome, "projects");
  for (const cwd of preferredCwds) {
    const candidate = join(projectsDir, projectSlug(cwd), `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  if (!existsSync(projectsDir)) return null;
  for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface SessionCopy {
  sessionId: string;
  transcriptPath: string;
  /** Removes every file the copy created. */
  undo(): Promise<void>;
}

/**
 * Copies a session into the project directory for `targetCwd` under a new
 * session ID. Each JSONL line that names the old session is rewritten to the
 * new one; the original files are only read.
 */
export async function copySession(args: {
  claudeHome: string;
  sourcePath: string;
  sourceSessionId: string;
  targetCwd: string;
}): Promise<SessionCopy> {
  const sessionId = randomUUID();
  const targetDir = join(args.claudeHome, "projects", projectSlug(args.targetCwd));
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const transcriptPath = join(targetDir, `${sessionId}.jsonl`);
  const created: string[] = [];
  try {
    await writeAtomic(transcriptPath, rewriteTranscript(await readFile(args.sourcePath, "utf8"), args.sourceSessionId, sessionId));
    created.push(transcriptPath);

    const sourceSidecar = args.sourcePath.replace(/\.jsonl$/, "");
    if (existsSync(sourceSidecar)) {
      const targetSidecar = join(targetDir, sessionId);
      await cp(sourceSidecar, targetSidecar, { recursive: true, errorOnExist: true, force: false });
      created.push(targetSidecar);
      for (const file of await listJsonl(targetSidecar)) {
        await writeAtomic(file, rewriteTranscript(await readFile(file, "utf8"), args.sourceSessionId, sessionId));
      }
    }
  } catch (error) {
    await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
    throw error;
  }
  return {
    sessionId,
    transcriptPath,
    undo: async () => {
      await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
    },
  };
}

export function rewriteTranscript(text: string, fromSessionId: string, toSessionId: string): string {
  return text.split("\n").map((line) => {
    if (line.trim() === "") return line;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.sessionId !== fromSessionId) return line;
      entry.sessionId = toSessionId;
      return JSON.stringify(entry);
    } catch {
      return line;
    }
  }).join("\n");
}

async function listJsonl(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(entry.parentPath, entry.name));
  }
  return files;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.t3-import-${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}
