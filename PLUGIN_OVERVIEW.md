Move your T3 Code threads into bb without losing the conversation or the agent's context.

## What you get

- Every selected T3 thread appears in the matching bb project with its messages, reasoning, tool calls, plans, and original dates.
- A follow-up message in bb resumes the original Claude Code or Codex session, so the agent remembers the whole thread.
- T3 Code keeps working: by default bb resumes a copy of each Claude Code session, so continuing in one app never changes the other.

## How it works

Run `bb t3-import preview` to see which threads would be imported, which bb projects they land in, and how each session resumes. Settled threads are left out unless you add `--include-settled`. Nothing changes until `bb t3-import run --yes`, which backs up the bb database first and skips any thread it has already imported.

## Requirements

T3 Code, Claude Code, and bb must run on the same computer. This release supports bb 0.45 and writes threads directly to the bb database, checking its tables before every run.
