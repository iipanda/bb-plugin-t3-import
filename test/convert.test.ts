import assert from "node:assert/strict";
import { test } from "node:test";
import { convertTimeline, MAX_TEXT, resultText } from "../src/convert.ts";
import { T3Source } from "../src/t3.ts";
import { activity, fixture, message, seedThread, turn } from "./helpers.ts";

function convert(sessionId: string | null = "sess-1") {
  const f = fixture();
  seedThread(f, { id: "t1", title: "Fix the build" });
  message(f, "t1", "user", "Please fix the build", "2026-09-20T10:00:00.000Z", null,
    [{ type: "image", name: "screenshot.png", mimeType: "image/png" }]);
  message(f, "t1", "reasoning", "Checking the logs", "2026-09-20T10:00:01.000Z", "turn-a");
  activity(f, "t1", "tool.started", { itemType: "command_execution", toolCallId: "c1", data: { toolName: "Bash", input: {} } }, "2026-09-20T10:00:02.000Z", "turn-a");
  activity(f, "t1", "tool.completed", {
    itemType: "command_execution", toolCallId: "c1", status: "completed",
    data: { toolName: "Bash", input: { command: "npm test" }, result: { type: "tool_result", content: "2 passing" } },
  }, "2026-09-20T10:00:05.000Z", "turn-a");
  activity(f, "t1", "tool.completed", {
    itemType: "mcp_tool_call", toolCallId: "c2", status: "failed",
    data: { toolName: "mcp__github__get_issue", input: { number: 7 }, result: { content: [{ type: "text", text: "not found" }] } },
  }, "2026-09-20T10:00:06.000Z", "turn-a");
  message(f, "t1", "assistant", "Fixed it.", "2026-09-20T10:00:07.000Z", "turn-a");
  turn(f, "t1", "turn-a", "completed");
  message(f, "t1", "user", "Now deploy", "2026-09-20T11:00:00.000Z");
  activity(f, "t1", "tool.denied", { toolName: "Bash", toolUseId: "c3", detail: "Blocked by policy" }, "2026-09-20T11:00:01.000Z", "turn-b");
  turn(f, "t1", "turn-b", "interrupted");

  const source = new T3Source(f.t3Path);
  const thread = source.threads()[0]!;
  const history = convertTimeline(thread, source.timeline("t1"), { providerThreadId: sessionId });
  source.close();
  return history;
}

const parse = (data: string) => JSON.parse(data) as Record<string, any>;

test("records the provider identity and replays turns in bb's event order", () => {
  const history = convert();
  assert.deepEqual(history.events.map((event) => event.type), [
    "thread/started", "thread/identity",
    "client/turn/requested", "turn/started", "turn/input/accepted",
    "item/completed", "item/completed", "item/completed", "item/completed", "turn/completed",
    "client/turn/requested", "turn/started", "turn/input/accepted", "item/completed", "turn/completed",
  ]);
  assert.deepEqual(history.events.map((event) => event.sequence), history.events.map((_, index) => index + 1));
  const identity = history.events[1]!;
  assert.equal(identity.providerThreadId, "sess-1");
  assert.deepEqual(parse(identity.data), { providerThreadId: "sess-1" });
  for (const event of history.events) {
    assert.equal(event.scopeKind === "turn", event.turnId !== null, `${event.type} scope matches its turn ID`);
    if (event.type === "client/turn/requested" || event.type === "thread/started") assert.equal(event.providerThreadId, null);
    else assert.equal(event.providerThreadId, "sess-1");
  }
  for (let index = 1; index < history.events.length; index++) {
    assert.ok(history.events[index]!.createdAt >= history.events[index - 1]!.createdAt, "timestamps never go backwards");
  }
  assert.equal(history.userMessages, 2);
  assert.equal(history.assistantMessages, 1);
  assert.equal(history.toolCalls, 3);
});

test("links each user message to its accepted turn input", () => {
  const history = convert();
  const request = parse(history.events[2]!.data);
  const accepted = parse(history.events[4]!.data);
  assert.equal(accepted.clientRequestId, request.requestId);
  assert.equal(request.target.kind, "new-turn");
  assert.equal(request.execution.model, "claude-opus-5-5");
  assert.equal(request.execution.reasoningLevel, "high");
  assert.equal(request.input[0].text, "Please fix the build\n\n[Attached in T3 Code: screenshot.png (image/png)]");
});

test("maps Bash to commandExecution and MCP tools to toolCall with their server", () => {
  const items = convert().events.filter((event) => event.type === "item/completed").map((event) => parse(event.data).item);
  assert.deepEqual(items[0], { type: "reasoning", id: items[0].id, summary: [], content: ["Checking the logs"] });
  assert.equal(items[1].type, "commandExecution");
  assert.equal(items[1].command, "npm test");
  assert.equal(items[1].aggregatedOutput, "2 passing");
  assert.equal(items[1].status, "completed");
  assert.equal(items[1].approvalStatus, null);
  assert.equal(items[2].type, "toolCall");
  assert.equal(items[2].server, "github");
  assert.equal(items[2].tool, "get_issue");
  assert.equal(items[2].status, "failed");
  assert.equal(items[2].error, "not found");
  assert.equal(items[3].type, "agentMessage");
  assert.equal(items[4].tool, "Bash");
  assert.equal(items[4].error, "Blocked by policy");
});

test("carries T3 turn outcomes into turn/completed", () => {
  const completed = convert().events.filter((event) => event.type === "turn/completed").map((event) => parse(event.data).status);
  assert.deepEqual(completed, ["completed", "interrupted"]);
});

test("leaves out the identity when there is no session to resume", () => {
  const history = convert(null);
  assert.equal(history.events.some((event) => event.type === "thread/identity"), false);
  assert.ok(history.events.every((event) => event.providerThreadId === null));
});

test("flattens tool results and caps oversized text", () => {
  assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "tool_reference", tool_name: "WebFetch" }] }), "a\n[tool: WebFetch]");
  assert.equal(resultText({ stdout: "out", stderr: "err" }), "out\nerr");
  assert.equal(resultText(null), "");
  const f = fixture();
  seedThread(f, { id: "big" });
  message(f, "big", "user", "go", "2026-09-20T10:00:00.000Z");
  activity(f, "big", "tool.completed", {
    itemType: "command_execution", toolCallId: "x", status: "completed",
    data: { toolName: "Bash", input: { command: "cat big" }, result: { content: "x".repeat(MAX_TEXT + 50) } },
  }, "2026-09-20T10:00:01.000Z");
  const source = new T3Source(f.t3Path);
  const history = convertTimeline(source.threads()[0]!, source.timeline("big"), { providerThreadId: null });
  source.close();
  const output = parse(history.events.find((event) => event.itemKind === "commandExecution")!.data).item.aggregatedOutput as string;
  assert.ok(output.startsWith("x".repeat(MAX_TEXT)));
  assert.match(output, /50 more characters not imported/);
});
