// bb-plugin-t3-import: the `bb t3-import` command. `preview` reads T3 Code,
// bb, and Claude Code state and changes nothing; `run --yes` backs up bb.db
// and writes the planned threads. See src/importer.ts for the plan rules.
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  planImport, runImport,
  type ImportFilters, type ImportPlan, type ImporterDeps, type LedgerEntry, type PlannedThread, type RunResult, type SessionMode,
} from "./src/importer.ts";

const LEDGER_PREFIX = "import:";

const selectionOptions = {
  project: {
    type: "string",
    repeatable: true,
    split: ",",
    aliases: ["projects"],
    description: "T3 project title, folder name, or absolute path; repeat or comma-separate (default: every project)",
  },
  thread: {
    type: "string",
    repeatable: true,
    split: ",",
    aliases: ["threads"],
    description: "T3 thread ID to import; a selected thread is imported even when settled or archived",
  },
  "include-settled": { type: "boolean", description: "Also import threads marked settled in T3 Code, as open bb threads" },
  "archive-settled": {
    type: "boolean",
    aliases: ["settled-as-archived"],
    description: "Also import settled threads, archived in bb at the time T3 settled them (takes precedence over --include-settled)",
  },
  "exclude-archived": { type: "boolean", description: "Leave out threads archived in T3 Code" },
  "empty-projects": {
    type: "boolean",
    aliases: ["include-empty-projects", "projects-without-threads"],
    description: "Also create bb projects for selected T3 projects that have no thread to import (ignored with --thread)",
  },
  limit: { type: "integer", min: 1, max: 10_000, description: "Import at most this many threads" },
  session: {
    type: "enum",
    values: ["copy", "share"],
    default: "copy",
    description: "copy: resume a copy of each Claude Code session (T3 stays untouched); share: resume the T3 session itself",
  },
  json: { type: "boolean", description: "Print machine-readable JSON" },
} as const;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    t3DataDir: {
      type: "string",
      label: "T3 Code data directory",
      description: "Folder that holds T3 Code's state.sqlite.",
      default: join(homedir(), ".t3", "userdata"),
    },
    claudeHome: {
      type: "string",
      label: "Claude Code home",
      description: "Folder that holds Claude Code's projects/ session transcripts.",
      default: join(homedir(), ".claude"),
    },
  });
  const { t3DataDir, claudeHome } = await settings.get();
  const dataDir = bb.server.experimental_dataDir;

  async function deps(): Promise<ImporterDeps> {
    const hostId = (await bb.sdk.system.config()).primaryHostId;
    if (hostId === null) {
      throw new PluginCliError("bb has no primary host yet", { code: "no_primary_host", hint: "Run `bb status` and retry once the server machine is enrolled." });
    }
    const toRef = (project: { id: string; name: string; sources: { hostId: string; path: string }[] }) => ({
      id: project.id, name: project.name, sources: project.sources.map((source) => ({ hostId: source.hostId, path: source.path })),
    });
    return {
      t3DbPath: join(t3DataDir, "state.sqlite"),
      bbDbPath: join(dataDir, "bb.db"),
      claudeHome,
      backupDir: join(dataDir, "plugins", "t3-import", "backups"),
      hostId,
      listProjects: async () => (await bb.sdk.projects.list()).map(toRef),
      createProject: async (name, path) => toRef(await bb.sdk.projects.create({ name, source: { type: "local_path", hostId, path } })),
      ledger: {
        get: (id) => bb.storage.kv.get<LedgerEntry>(`${LEDGER_PREFIX}${id}`),
        set: (id, entry) => bb.storage.kv.set(`${LEDGER_PREFIX}${id}`, entry),
      },
    };
  }

  function filtersOf(options: {
    project?: string[]; thread?: string[]; "include-settled"?: boolean; "archive-settled"?: boolean; "exclude-archived"?: boolean; "empty-projects"?: boolean; limit?: number;
  }): ImportFilters {
    return {
      projects: options.project ?? [],
      threads: options.thread ?? [],
      includeSettled: options["include-settled"] === true,
      archiveSettled: options["archive-settled"] === true,
      includeArchived: options["exclude-archived"] !== true,
      limit: options.limit ?? null,
      emptyProjects: options["empty-projects"] === true,
    };
  }

  async function plan(options: Parameters<typeof filtersOf>[0] & { session?: string }): Promise<{ deps: ImporterDeps; plan: ImportPlan; mode: SessionMode }> {
    const mode: SessionMode = options.session === "share" ? "share" : "copy";
    const resolved = await deps();
    try {
      return { deps: resolved, plan: await planImport(resolved, filtersOf(options), mode), mode };
    } catch (error) {
      throw new PluginCliError(error instanceof Error ? error.message : String(error), {
        code: "plan_failed",
        hint: `Check that T3 Code's state.sqlite is in ${t3DataDir} (setting t3DataDir).`,
      });
    }
  }

  bb.cli.register(defineCli({
    name: "t3-import",
    summary: "Import T3 Code threads into bb",
    description: "Preview first with `bb t3-import preview`; nothing is written until `bb t3-import run --yes`.",
    commands: {
      preview: cliCommand({
        summary: "Show which T3 Code threads would be imported, without changing anything",
        aliases: ["plan", "scan"],
        options: selectionOptions,
        async run({ options }) {
          const { plan: result, mode } = await plan(options);
          return { exitCode: 0, stdout: options.json ? JSON.stringify(planJson(result, mode)) : formatPlan(result, mode, options) };
        },
      }),
      run: cliCommand({
        summary: "Import the previewed threads (backs up bb.db first; requires --yes)",
        aliases: ["import"],
        options: { ...selectionOptions, yes: { type: "boolean", aliases: ["confirm"], description: "Write to bb; without it, only the preview is shown" } },
        async run({ options }) {
          const { deps: resolved, plan: result, mode } = await plan(options);
          if (!options.yes) {
            return {
              exitCode: 1,
              stdout: options.json ? JSON.stringify(planJson(result, mode)) : formatPlan(result, mode, options),
              stderr: "Nothing was written. Re-run with --yes to import these threads.",
            };
          }
          const outcome = await runImport(resolved, result);
          return { exitCode: outcome.failed.length + outcome.failedProjects.length > 0 ? 1 : 0, stdout: options.json ? JSON.stringify(runJson(outcome)) : formatRun(outcome) };
        },
      }),
      status: cliCommand({
        summary: "List T3 Code threads this plugin has imported",
        options: { json: { type: "boolean", description: "Print machine-readable JSON" } },
        async run({ options }) {
          const keys = await bb.storage.kv.list(LEDGER_PREFIX);
          const entries: (LedgerEntry & { t3ThreadId: string })[] = [];
          for (const key of keys) {
            const entry = await bb.storage.kv.get<LedgerEntry>(key);
            if (entry) entries.push({ ...entry, t3ThreadId: key.slice(LEDGER_PREFIX.length) });
          }
          entries.sort((a, b) => a.importedAt - b.importedAt);
          if (options.json) return { exitCode: 0, stdout: JSON.stringify(entries) };
          if (entries.length === 0) return { exitCode: 0, stdout: "No T3 Code threads imported yet." };
          return {
            exitCode: 0,
            stdout: entries.map((entry) =>
              `${entry.bbThreadId}  from T3 ${entry.t3ThreadId}  session ${entry.sessionMode}${entry.sessionId ? ` ${entry.sessionId}` : ""}  ${new Date(entry.importedAt).toISOString()}`,
            ).join("\n"),
          };
        },
      }),
    },
  }));
}

function planJson(plan: ImportPlan, mode: SessionMode) {
  return {
    sessionMode: mode,
    filtered: plan.filtered,
    projects: plan.projects,
    threads: plan.threads.map((thread) => ({
      t3ThreadId: thread.t3.id,
      title: thread.t3.title,
      t3Project: thread.t3.projectTitle,
      action: thread.action,
      reason: thread.reason,
      provider: thread.providerId,
      environmentPath: thread.environmentPath,
      bbProject: thread.bbProject,
      session: thread.session.kind === "copy"
        ? { kind: "copy", sourceSessionId: thread.session.sourceSessionId }
        : thread.session,
      archived: thread.archivedAtMs !== null,
      settled: thread.t3.settled,
      warnings: thread.warnings,
    })),
  };
}

function runJson(result: RunResult) {
  return {
    imported: result.imported, failed: result.failed, backupPath: result.backupPath,
    createdProjects: result.createdProjects, failedProjects: result.failedProjects,
  };
}

function formatPlan(plan: ImportPlan, mode: SessionMode, options: { "include-settled"?: boolean; "archive-settled"?: boolean }): string {
  const lines: string[] = [];
  const byProject = new Map<string, PlannedThread[]>();
  for (const thread of plan.threads) {
    const list = byProject.get(thread.t3.workspaceRoot) ?? [];
    list.push(thread);
    byProject.set(thread.t3.workspaceRoot, list);
  }
  for (const [root, threads] of byProject) {
    const project = threads[0]!.bbProject;
    lines.push(`${root} → bb project "${project.name}" (${project.id ?? "will be created"})`);
    for (const thread of threads) {
      const flags = [
        thread.t3.archivedAtMs !== null ? "archived" : null,
        thread.t3.settled ? (thread.action === "import" && thread.t3.archivedAtMs === null && thread.archivedAtMs !== null ? "settled → archived in bb" : "settled") : null,
      ].filter(Boolean).join(", ");
      const label = `${thread.t3.title}${flags ? ` (${flags})` : ""}`;
      if (thread.action === "skip") {
        lines.push(`  skip    ${label} — ${thread.reason}`);
        continue;
      }
      lines.push(`  import  ${label}  [${thread.providerId}, ${sessionLabel(thread)}]`);
      for (const warning of thread.warnings) lines.push(`          ! ${warning}`);
    }
  }
  for (const project of plan.projects) {
    lines.push(project.action === "create"
      ? `${project.workspaceRoot} → bb project "${project.name}" (will be created, no threads to import)`
      : `${project.workspaceRoot} → skip project — ${project.reason}`);
  }
  const importing = plan.threads.filter((thread) => thread.action === "import").length;
  const creating = plan.projects.filter((project) => project.action === "create").length;
  const filtered = Object.entries(plan.filtered).map(([reason, count]) => `${count} ${reason}`).join(", ");
  if (lines.length === 0) lines.push("No T3 Code threads match.");
  lines.push("");
  lines.push(`${importing} thread${importing === 1 ? "" : "s"} to import (session: ${mode})`
    + `${creating > 0 ? `, ${creating} project${creating === 1 ? "" : "s"} without threads to create` : ""}.`
    + `${filtered ? ` Left out: ${filtered}.` : ""}`);
  if (!options["include-settled"] && !options["archive-settled"] && plan.filtered.settled) {
    lines.push("Add --archive-settled to import settled threads as archived, or --include-settled to import them open.");
  }
  if (importing + creating > 0) lines.push("Nothing was written. Run the same command as `bb t3-import run ... --yes` to import.");
  return lines.join("\n");
}

function sessionLabel(thread: PlannedThread): string {
  switch (thread.session.kind) {
    case "copy": return `resumes a copy of session ${thread.session.sourceSessionId.slice(0, 8)}`;
    case "share": return `resumes session ${thread.session.sessionId.slice(0, 8)}`;
    case "none": return "history only";
  }
}

function formatRun(result: RunResult): string {
  const lines: string[] = [];
  for (const project of result.createdProjects) lines.push(`created   project "${project.name}" → ${project.bbProjectId} (${project.workspaceRoot})`);
  for (const failure of result.failedProjects) lines.push(`FAILED    project "${failure.name}" (${failure.workspaceRoot}): ${failure.error}`);
  if (result.backupPath) lines.push(`Backed up bb.db to ${result.backupPath}`);
  for (const thread of result.imported) {
    lines.push(`imported  ${thread.title} → ${thread.bbThreadId} (${thread.events} events${thread.sessionId ? `, session ${thread.sessionId}` : ""})`);
  }
  for (const failure of result.failed) lines.push(`FAILED    ${failure.title} (${failure.t3ThreadId}): ${failure.error}`);
  if (lines.length === 0) lines.push("Nothing to import.");
  else {
    const projects = result.createdProjects.length + result.failedProjects.length > 0
      ? `; ${result.createdProjects.length} project${result.createdProjects.length === 1 ? "" : "s"} created, ${result.failedProjects.length} failed`
      : "";
    lines.push("", `${result.imported.length} imported, ${result.failed.length} failed${projects}. Reload the bb app if the threads do not appear.`);
  }
  return lines.join("\n");
}
