// Converts a T3 Code thread timeline into bb thread events. The shapes follow
// the events bb's own Claude Code and Codex providers record: a user message
// is a client/turn/requested event followed by turn/started and
// turn/input/accepted; agent output is item/completed rows; turn/completed
// closes the turn. bb only replays these rows, so nothing is re-executed.
import { randomBytes } from "node:crypto";
import type { T3Entry, T3Thread, T3Timeline } from "./t3.ts";
import { record, string } from "./t3.ts";

/** Longest tool output or argument text kept per item. */
export const MAX_TEXT = 100_000;

export interface ImportEvent {
  id: string;
  sequence: number;
  scopeKind: "thread" | "turn";
  turnId: string | null;
  providerThreadId: string | null;
  type: string;
  itemId: string | null;
  itemKind: string | null;
  data: string;
  createdAt: number;
}

export interface History {
  events: ImportEvent[];
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
}

export interface ConvertOptions {
  /** Session ID the bb thread resumes; null leaves the thread without a provider identity. */
  providerThreadId: string | null;
}

export function newId(prefix: string): string {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  const random = randomBytes(10);
  let suffix = "";
  for (let index = 0; index < 10; index++) suffix += alphabet[random[index]! % alphabet.length];
  return `${prefix}_${suffix}`;
}

export function convertTimeline(thread: T3Thread, timeline: T3Timeline, options: ConvertOptions): History {
  const providerThreadId = options.providerThreadId;
  // Turn events require a provider thread ID in their payload even when the
  // thread has no resumable session.
  const payloadThreadId = providerThreadId ?? `t3-import-${thread.id}`;
  const prefix = newId("t3").slice(3);
  const events: ImportEvent[] = [];
  let sequence = 0;
  let clock = thread.createdAtMs;
  let turnCount = 0;
  let itemCount = 0;
  let users = 0;
  let assistants = 0;
  let tools = 0;

  const add = (type: string, data: Record<string, unknown>, at: number, turnId: string | null, item: Record<string, unknown> | null = null) => {
    clock = Math.max(clock, Math.floor(at));
    const threadLevel = type === "client/turn/requested" || type === "thread/started";
    events.push({
      id: newId("evt"),
      sequence: ++sequence,
      scopeKind: turnId ? "turn" : "thread",
      turnId,
      providerThreadId: threadLevel ? null : providerThreadId,
      type,
      itemId: item ? String(item.id) : null,
      itemKind: item ? String(item.type) : null,
      data: JSON.stringify(data),
      createdAt: clock,
    });
  };

  add("thread/started", {}, thread.createdAtMs, null);
  if (providerThreadId !== null) add("thread/identity", { providerThreadId }, thread.createdAtMs, null);

  let turn: { id: string; t3TurnIds: Set<string>; lastAt: number } | null = null;
  const closeTurn = () => {
    if (!turn) return;
    add("turn/completed", { providerThreadId: payloadThreadId, status: turnStatus(turn.t3TurnIds, timeline.turnStates) }, turn.lastAt, turn.id);
    turn = null;
  };
  const openTurn = (at: number) => {
    turn = { id: `${prefix}-t${++turnCount}`, t3TurnIds: new Set(), lastAt: at };
    add("turn/started", { providerThreadId: payloadThreadId }, at, turn.id);
    return turn;
  };

  for (const entry of timeline.entries) {
    if (entry.kind === "user") {
      closeTurn();
      users++;
      const requestId = newId("creq");
      add("client/turn/requested", {
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: { method: "turn/start", params: {} },
        requestId,
        senderThreadId: null,
        input: [{ type: "text", text: userText(entry), mentions: [] }],
        target: { kind: "new-turn" },
        execution: {
          model: thread.model ?? "default",
          permissionMode: "auto",
          reasoningLevel: thread.effort ?? "medium",
          serviceTier: "default",
          source: "client/turn/requested",
        },
      }, entry.at, null);
      const opened = openTurn(entry.at);
      add("turn/input/accepted", { providerThreadId: payloadThreadId, clientRequestId: requestId }, entry.at, opened.id);
      continue;
    }
    const current: { id: string; t3TurnIds: Set<string>; lastAt: number } = turn ?? openTurn(entry.at);
    if (entry.turnId) current.t3TurnIds.add(entry.turnId);
    current.lastAt = Math.max(current.lastAt, entry.at);
    const item = toItem(entry, `${prefix}-i${++itemCount}`);
    if (item.type === "agentMessage") assistants++;
    if (item.type === "toolCall" || item.type === "commandExecution") tools++;
    add("item/completed", { providerThreadId: payloadThreadId, item }, entry.at, current.id, item);
  }
  closeTurn();

  return { events, userMessages: users, assistantMessages: assistants, toolCalls: tools };
}

function turnStatus(t3TurnIds: Set<string>, states: Map<string, string>): "completed" | "failed" | "interrupted" {
  let status: "completed" | "failed" | "interrupted" = "completed";
  for (const id of t3TurnIds) {
    const state = states.get(id);
    if (state === "error") return "failed";
    if (state === "interrupted") status = "interrupted";
  }
  return status;
}

function userText(entry: Extract<T3Entry, { kind: "user" }>): string {
  if (entry.attachments.length === 0) return entry.text;
  const notes = entry.attachments.map((file) => `[Attached in T3 Code: ${file.name}${file.mimeType ? ` (${file.mimeType})` : ""}]`);
  return [entry.text, ...notes].filter((part) => part !== "").join("\n\n");
}

export function toItem(entry: Exclude<T3Entry, { kind: "user" }>, id: string): Record<string, unknown> {
  switch (entry.kind) {
    case "assistant":
      return { type: "agentMessage", id, text: entry.text };
    case "reasoning":
      return { type: "reasoning", id, summary: [], content: [entry.text] };
    case "plan":
      return { type: "plan", id, text: entry.text };
    case "compaction":
      return { type: "contextCompaction", id };
    case "tool": {
      const command = string(entry.input.command);
      if (entry.itemType === "command_execution" && entry.toolName === "Bash" && command) {
        return {
          type: "commandExecution", id, command: cap(command), cwd: "", status: entry.status,
          approvalStatus: null, aggregatedOutput: cap(resultText(entry.result)),
        };
      }
      const mcp = /^mcp__(.+?)__(.+)$/.exec(entry.toolName);
      const item: Record<string, unknown> = {
        type: "toolCall", id,
        ...(mcp ? { server: mcp[1], tool: mcp[2] } : { tool: entry.toolName }),
        arguments: capArguments(entry.input),
        status: entry.status,
      };
      if (entry.error !== null) item.error = cap(entry.error);
      else if (entry.result !== null) {
        const text = cap(resultText(entry.result));
        if (entry.status === "failed") item.error = text;
        else item.result = text;
      }
      return item;
    }
  }
}

/** Flattens a Claude tool result into display text. */
export function resultText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  const value = record(result);
  const content = value.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((raw) => {
      const part = record(raw);
      if (part.type === "text") return string(part.text) ?? "";
      if (part.type === "tool_reference") return `[tool: ${string(part.tool_name) ?? "unknown"}]`;
      if (part.type === "image") return "[image]";
      return JSON.stringify(raw);
    }).join("\n");
  }
  const stdout = string(value.stdout);
  const stderr = string(value.stderr);
  if (stdout !== undefined || stderr !== undefined) return [stdout, stderr].filter(Boolean).join("\n");
  return JSON.stringify(result);
}

export function cap(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n… [${text.length - MAX_TEXT} more characters not imported]`;
}

function capArguments(input: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(input);
  if (text.length <= MAX_TEXT) return input;
  const capped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    capped[key] = typeof value === "string" ? cap(value) : value;
  }
  return capped;
}
