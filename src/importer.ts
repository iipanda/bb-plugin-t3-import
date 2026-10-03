// Plans and runs a T3 Code import. Planning only reads T3, bb, and Claude
// Code state; `run` with `write: true` is the only path that changes anything.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { BbStore } from "./bb-store.ts";
import { copySession, findSession, projectSlug, type SessionCopy } from "./claude-session.ts";
import { convertTimeline } from "./convert.ts";
import { T3Source, type T3Thread } from "./t3.ts";

export type SessionMode = "copy" | "share";

export interface ImportFilters {
  /** T3 project titles, folder names, or absolute workspace paths. */
  projects: string[];
  /** T3 thread IDs. */
  threads: string[];
  includeSettled: boolean;
  includeArchived: boolean;
  limit: number | null;
}

export interface LedgerEntry {
  bbThreadId: string;
  bbProjectId: string;
  sessionId: string | null;
  sessionMode: SessionMode | "none";
  importedAt: number;
}

export interface BbProjectRef {
  id: string;
  name: string;
  sources: { hostId: string; path: string }[];
}

export interface ImporterDeps {
  t3DbPath: string;
  bbDbPath: string;
  claudeHome: string;
  backupDir: string;
  hostId: string;
  listProjects(): Promise<BbProjectRef[]>;
  createProject(name: string, path: string): Promise<BbProjectRef>;
  ledger: {
    get(t3ThreadId: string): Promise<LedgerEntry | undefined>;
    set(t3ThreadId: string, entry: LedgerEntry): Promise<void>;
  };
}

export type SessionPlan =
  | { kind: "copy"; sourceSessionId: string; sourcePath: string }
  | { kind: "share"; sessionId: string }
  | { kind: "none"; reason: string };

export interface PlannedThread {
  t3: T3Thread;
  action: "import" | "skip";
  reason: string | null;
  providerId: "claude-code" | "codex";
  environmentPath: string;
  bbProject: { id: string | null; name: string };
  session: SessionPlan;
  warnings: string[];
}

export interface ImportPlan {
  threads: PlannedThread[];
  /** T3 threads left out by the filters, by reason. */
  filtered: Record<string, number>;
}

export interface ImportedThread {
  t3ThreadId: string;
  title: string;
  bbThreadId: string;
  bbProjectId: string;
  sessionId: string | null;
  events: number;
}

export interface RunResult {
  plan: ImportPlan;
  imported: ImportedThread[];
  failed: { t3ThreadId: string; title: string; error: string }[];
  backupPath: string | null;
}

export async function planImport(deps: ImporterDeps, filters: ImportFilters, sessionMode: SessionMode): Promise<ImportPlan> {
  const t3 = new T3Source(deps.t3DbPath);
  const bb = new BbStore(deps.bbDbPath);
  try {
    const projects = await deps.listProjects();
    const filtered: Record<string, number> = {};
    const skipBy = (reason: string) => { filtered[reason] = (filtered[reason] ?? 0) + 1; };
    const projectFilter = filters.projects.map((value) => value.trim()).filter(Boolean);
    const threadFilter = new Set(filters.threads);
    const planned: PlannedThread[] = [];

    for (const thread of t3.threads()) {
      if (threadFilter.size > 0 && !threadFilter.has(thread.id)) { skipBy("not selected"); continue; }
      if (projectFilter.length > 0 && !projectFilter.some((value) => matchesProject(thread, value))) { skipBy("other project"); continue; }
      if (thread.settled && !filters.includeSettled && !threadFilter.has(thread.id)) { skipBy("settled"); continue; }
      if (thread.archivedAtMs !== null && !filters.includeArchived && !threadFilter.has(thread.id)) { skipBy("archived"); continue; }
      planned.push(await planThread(deps, bb, projects, thread, sessionMode));
    }

    const limited = filters.limit === null ? planned : limit(planned, filters.limit, skipBy);
    return { threads: limited, filtered };
  } finally {
    t3.close();
    bb.close();
  }
}

function limit(planned: PlannedThread[], max: number, skipBy: (reason: string) => void): PlannedThread[] {
  let remaining = max;
  return planned.filter((thread) => {
    if (thread.action !== "import") return true;
    if (remaining > 0) { remaining--; return true; }
    skipBy("over --limit");
    return false;
  });
}

async function planThread(deps: ImporterDeps, bb: BbStore, projects: BbProjectRef[], thread: T3Thread, sessionMode: SessionMode): Promise<PlannedThread> {
  const root = resolve(thread.workspaceRoot);
  const environmentPath = thread.worktreePath && existsSync(thread.worktreePath) ? resolve(thread.worktreePath) : root;
  const project = projects.find((candidate) => candidate.sources.some((source) => source.hostId === deps.hostId && resolve(source.path) === root));
  const providerId = thread.provider === "codex" ? "codex" : "claude-code";
  const warnings: string[] = [];
  const base = {
    t3: thread, providerId, environmentPath, warnings,
    bbProject: { id: project?.id ?? null, name: project?.name ?? basename(root) },
  } as const;

  const existing = await deps.ledger.get(thread.id);
  if (existing && bb.threadAlive(existing.bbThreadId)) {
    return { ...base, action: "skip", reason: `already imported as ${existing.bbThreadId}`, session: { kind: "none", reason: "already imported" } };
  }
  if (!existsSync(root)) {
    return { ...base, action: "skip", reason: `project folder is missing: ${root}`, session: { kind: "none", reason: "no folder" } };
  }
  if (environmentPath !== root) warnings.push(`runs in the T3 worktree ${environmentPath}`);

  const session = await planSession(deps, bb, thread, environmentPath, sessionMode);
  if (session.kind === "none") warnings.push(`history only: ${session.reason}; the next message starts a new ${providerId === "codex" ? "Codex" : "Claude"} session`);
  return { ...base, action: "import", reason: null, session };
}

async function planSession(deps: ImporterDeps, bb: BbStore, thread: T3Thread, environmentPath: string, sessionMode: SessionMode): Promise<SessionPlan> {
  if (thread.sessionId === null) return { kind: "none", reason: "T3 recorded no provider session" };
  if (thread.provider === "codex") {
    // Codex resumes a thread by ID from its own state, so the session is shared.
    const claimant = bb.sessionClaimant(thread.sessionId);
    if (claimant) return { kind: "none", reason: `bb thread ${claimant} already resumes this Codex session` };
    return { kind: "share", sessionId: thread.sessionId };
  }
  const cwds = [thread.worktreePath, thread.workspaceRoot, environmentPath].filter((value): value is string => Boolean(value));
  const sourcePath = await findSession(deps.claudeHome, thread.sessionId, cwds);
  if (sourcePath === null) return { kind: "none", reason: "the Claude Code session file is missing" };
  if (sessionMode === "copy") return { kind: "copy", sourceSessionId: thread.sessionId, sourcePath };
  const claimant = bb.sessionClaimant(thread.sessionId);
  if (claimant) return { kind: "none", reason: `bb thread ${claimant} already resumes this session` };
  if (!sourcePath.includes(`/${projectSlug(environmentPath)}/`)) {
    return { kind: "none", reason: "the shared session lives under a different working directory; use --session copy" };
  }
  return { kind: "share", sessionId: thread.sessionId };
}

export async function runImport(deps: ImporterDeps, plan: ImportPlan): Promise<RunResult> {
  const result: RunResult = { plan, imported: [], failed: [], backupPath: null };
  const todo = plan.threads.filter((thread) => thread.action === "import");
  if (todo.length === 0) return result;

  const t3 = new T3Source(deps.t3DbPath);
  const bb = new BbStore(deps.bbDbPath, true);
  try {
    result.backupPath = await bb.backup(deps.backupDir);
    const projectIds = new Map<string, string>();
    for (const planned of todo) {
      const root = resolve(planned.t3.workspaceRoot);
      let copy: SessionCopy | null = null;
      try {
        let projectId = planned.bbProject.id ?? projectIds.get(root) ?? null;
        if (projectId === null) {
          const existing = (await deps.listProjects()).find((candidate) =>
            candidate.sources.some((source) => source.hostId === deps.hostId && resolve(source.path) === root));
          projectId = existing?.id ?? (await deps.createProject(planned.bbProject.name, root)).id;
        }
        projectIds.set(root, projectId);

        let providerThreadId: string | null = null;
        if (planned.session.kind === "copy") {
          copy = await copySession({
            claudeHome: deps.claudeHome,
            sourcePath: planned.session.sourcePath,
            sourceSessionId: planned.session.sourceSessionId,
            targetCwd: planned.environmentPath,
          });
          providerThreadId = copy.sessionId;
        } else if (planned.session.kind === "share") {
          providerThreadId = planned.session.sessionId;
        }

        const history = convertTimeline(planned.t3, t3.timeline(planned.t3.id), { providerThreadId });
        const bbThreadId = bb.importThread({
          projectId,
          hostId: deps.hostId,
          environmentPath: planned.environmentPath,
          providerId: planned.providerId,
          title: planned.t3.title,
          createdAtMs: planned.t3.createdAtMs,
          updatedAtMs: planned.t3.updatedAtMs,
          archivedAtMs: planned.t3.archivedAtMs,
          history,
        });
        await deps.ledger.set(planned.t3.id, {
          bbThreadId, bbProjectId: projectId, sessionId: providerThreadId,
          sessionMode: planned.session.kind,
          importedAt: Date.now(),
        });
        result.imported.push({
          t3ThreadId: planned.t3.id, title: planned.t3.title, bbThreadId, bbProjectId: projectId,
          sessionId: providerThreadId, events: history.events.length,
        });
      } catch (error) {
        if (copy) await copy.undo().catch(() => undefined);
        result.failed.push({ t3ThreadId: planned.t3.id, title: planned.t3.title, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  } finally {
    t3.close();
    bb.close();
  }
}

function matchesProject(thread: T3Thread, value: string): boolean {
  if (value.startsWith("/") || value.startsWith("~")) return resolve(value.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) === resolve(thread.workspaceRoot);
  const needle = value.toLowerCase();
  return thread.projectTitle.toLowerCase() === needle || basename(thread.workspaceRoot).toLowerCase() === needle;
}
