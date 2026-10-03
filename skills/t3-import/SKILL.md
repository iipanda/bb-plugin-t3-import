---
name: t3-import
description: Import T3 Code threads into bb with `bb t3-import`; use when asked to bring T3 Code projects, threads, or conversations into bb.
---

# Import T3 Code threads

`bb t3-import` copies T3 Code threads into bb projects. Imported Claude Code and Codex threads resume their original
session on the next message.

1. Run `bb t3-import preview` (add `--project <name>` or `--thread <id>` to narrow it). It changes nothing.
2. Show the user the preview: the threads, their target bb projects, and any "history only" warnings. Settled T3
   threads are left out unless `--include-settled` is given.
3. Import only after the user approves: `bb t3-import run --yes` with the same selection options.
4. Report the imported bb thread IDs and the backup path from the output. `bb t3-import status` lists every import.

Options: `--project`, `--thread`, `--include-settled`, `--archive-settled` (import settled threads archived),
`--empty-projects` (also create bb projects for T3 projects with no thread to import), `--exclude-archived`, `--limit <n>`,
`--session copy|share` (default `copy`: bb resumes a copy of each Claude session and T3 stays untouched), `--json`.

The command runs on the bb server's machine and reads `~/.t3/userdata/state.sqlite` and `~/.claude` there. It writes
bb's database directly and supports bb 0.45 only. A rerun skips threads that are already imported.
