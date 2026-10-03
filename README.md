# bb-plugin-t3-import

A [bb](https://getbb.app) plugin that imports [T3 Code](https://t3.codes) threads into bb. Imported threads keep their
conversation, tool calls, and dates, and a follow-up message in bb resumes the original Claude Code or Codex session
with its full context.

```
bb t3-import preview                 # read-only: what would be imported
bb t3-import run --yes               # import it
bb t3-import status                  # what has been imported
```

## What it does

For each selected T3 thread, the plugin:

1. Finds or creates the bb project whose folder is the T3 project's workspace root.
2. For Claude Code threads, copies the Claude session transcript
   (`~/.claude/projects/<folder>/<session>.jsonl`, plus subagent transcripts) under a new session ID. bb resumes the
   copy, so continuing the thread in bb never changes what T3 Code resumes. `--session share` resumes T3's session
   itself instead. Codex threads always share the Codex thread, which Codex resumes by ID.
3. Converts T3's messages, reasoning, tool calls, plans, and compactions into bb thread events and writes them, with
   a project-checkout environment for the folder, to bb's database in one transaction per thread.

Nothing is written until `run --yes`. Each run backs up `bb.db` first (the last three backups are kept under
`<bb data dir>/plugins/t3-import/backups/`). A ledger in plugin storage records every imported thread, so running
the import again skips threads that are already in bb.

## Selecting threads

| Option | Effect |
| --- | --- |
| `--project <name or path>` | Only these T3 projects (title, folder name, or absolute path). Repeat or comma-separate. |
| `--thread <id>` | Only these T3 thread IDs. A selected thread is imported even when settled or archived. |
| `--include-settled` | Also import threads marked settled in T3 (left out by default). |
| `--exclude-archived` | Leave out threads archived in T3 (they are imported as archived by default). |
| `--limit <n>` | Import at most `n` threads; useful for a first test. |
| `--session copy\|share` | How Claude Code sessions are resumed (default `copy`). |
| `--json` | Machine-readable output. |

A thread is imported as history only, and its next message starts a new session, when T3 recorded no session or the
Claude transcript no longer exists. The preview lists these with a warning.

## Requirements and limits

- bb 0.45, and T3 Code, Claude Code, and bb on the same machine (the bb server's machine).
- The plugin writes bb's database directly, because bb has no API that creates a thread with existing history. It
  checks the tables and columns it writes before every run and refuses to run against a schema it does not know.
  `engines.bb` pins it to bb 0.45; check a new bb release with `scripts/check-events.mjs` before widening it.
- Images attached to T3 messages are noted by name in the message text; the image files are not copied.
- Threads appear after the bb app reloads its thread list.

Settings (`bb plugin config t3-import`): `t3DataDir` (default `~/.t3/userdata`) and `claudeHome` (default `~/.claude`).

## Development

```
npm install
npm run typecheck
npm test
bb plugin build
bb plugin install .
```

The tests build T3 and bb databases from `test/fixtures/*-schema.sql`, which are the table definitions of T3 Code and
bb 0.45. `scripts/check-events.mjs <bb.db>` parses imported events with the installed bb server's own event parser;
run it against a copy of `bb.db` after an import rehearsal or a bb update.
