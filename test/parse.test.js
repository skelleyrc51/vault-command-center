"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { routeLine } = require("../main.js").__test;

// Payloads below are trimmed copies of real `claude -p --output-format stream-json
// --verbose --include-partial-messages` output, not invented shapes.

test("a text delta becomes streamed text", () => {
  const line = JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    },
    session_id: "146035fb",
    parent_tool_use_id: null,
    uuid: "e7a4d1e7",
  });

  assert.deepStrictEqual(routeLine(line), { kind: "text", text: "hello" });
});

test("drops the high-volume system events that dominate the stream", () => {
  // Measured on a real one-word run: these three were 72KB of an 85KB stream.
  const noise = [
    { type: "system", subtype: "init", tools: ["Read", "Edit"], cwd: "/vault" },
    { type: "system", subtype: "commands_changed", commands: [{ name: "x" }] },
    { type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" },
    { type: "system", subtype: "hook_response", output: "{}" },
    { type: "rate_limit_event", rate_limit: { status: "allowed" } },
  ];

  for (const ev of noise) {
    assert.strictEqual(routeLine(JSON.stringify(ev)), null, `${ev.subtype || ev.type} should be dropped`);
  }
});

test("a line that is not JSON is surfaced raw rather than swallowed", () => {
  assert.deepStrictEqual(routeLine("claude: command failed"), {
    kind: "raw",
    text: "claude: command failed",
  });
});

test("a blank line produces nothing", () => {
  assert.strictEqual(routeLine("   "), null);
});

test("a thinking delta is routed separately from answer text", () => {
  const line = JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "weighing it up", estimated_tokens: 50 },
    },
  });

  assert.deepStrictEqual(routeLine(line), { kind: "thinking", text: "weighing it up" });
});

test("drops the partial deltas that carry no readable content", () => {
  for (const delta of [
    { type: "signature_delta", signature: "CAQS2wYKEAgSGAI4AUII" },
    { type: "input_json_delta", partial_json: '{"file_pa' },
  ]) {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta },
    });
    assert.strictEqual(routeLine(line), null, `${delta.type} should be dropped`);
  }
});

test("a tool call renders as one line naming the tool and its target", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01RCXe6",
          name: "Read",
          input: { file_path: "C:\\Users\\Monster X25\\vault\\Watchlist\\NVDA.md" },
        },
      ],
    },
  });

  assert.deepStrictEqual(routeLine(line), { kind: "tool", text: "Read(NVDA.md)" });
});

test("assistant text blocks are dropped because the deltas already streamed them", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });

  assert.strictEqual(routeLine(line), null);
});

test("the result event carries the run's real duration and cost", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 5539,
    total_cost_usd: 0.1449396,
    num_turns: 2,
  });

  assert.deepStrictEqual(routeLine(line), {
    kind: "result",
    ok: true,
    durationMs: 5539,
    costUsd: 0.1449396,
  });
});

test("an errored result is reported as an error, not a success", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    duration_ms: 1200,
    total_cost_usd: 0.01,
  });

  assert.deepStrictEqual(routeLine(line), {
    kind: "result",
    ok: false,
    durationMs: 1200,
    costUsd: 0.01,
  });
});

test("a status event updates the header rather than the transcript", () => {
  const line = JSON.stringify({ type: "system", subtype: "status", status: "requesting" });

  assert.deepStrictEqual(routeLine(line), { kind: "status", text: "requesting" });
});

test("a posix path in a tool call is reduced to its basename too", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "/home/u/vault/Watchlist/NVDA.md" } },
      ],
    },
  });

  assert.deepStrictEqual(routeLine(line), { kind: "tool", text: "Read(NVDA.md)" });
});

test("a tool call with no string argument shows the bare tool name", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [] } }] },
  });

  assert.deepStrictEqual(routeLine(line), { kind: "tool", text: "TodoWrite" });
});

// ---- Argument construction -------------------------------------------------

const { buildArgs } = require("../main.js").__test;

test("a read-only action is run with prompts denied outright", () => {
  const args = buildArgs({ prompt: "report only", writes: false });

  assert.deepStrictEqual(args, [
    "-p",
    "report only",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "manual",
    "--permission-prompts",
    "none",
  ]);
});

test("a writing action is run with edits accepted but nothing else", () => {
  const args = buildArgs({ prompt: "write the daily note", writes: true });

  assert.deepStrictEqual(args, [
    "-p",
    "write the daily note",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "acceptEdits",
  ]);
});

test("a writing action never disables the permission prompts", () => {
  // acceptEdits already auto-approves file edits; pairing it with
  // --permission-prompts none would silently deny everything else instead of
  // surfacing it, which is how a run looks successful while doing nothing.
  assert.ok(!buildArgs({ prompt: "x", writes: true }).includes("--permission-prompts"));
});

// ---- Section inspection ----------------------------------------------------
// Cache shapes below match what Obsidian's metadataCache returns: `headings` and
// `sections` both in document order, sections covering every block including the
// headings themselves.

const { sectionExists, sectionHasBody } = require("../main.js").__test;

function cacheFor(headings, sections) {
  return {
    headings: headings.map(([heading, line]) => ({
      heading,
      position: { start: { line }, end: { line } },
    })),
    sections: sections.map(([type, line]) => ({
      type,
      position: { start: { line }, end: { line } },
    })),
  };
}

test("a heading followed only by the next heading has no body", () => {
  // # NVDA / ## Thesis / ## Notes  - Thesis is empty
  const cache = cacheFor(
    [["NVDA", 0], ["Thesis", 2], ["Notes", 4]],
    [["heading", 0], ["heading", 2], ["heading", 4]]
  );
  assert.equal(sectionExists(cache, "Thesis"), true);
  assert.equal(sectionHasBody(cache, "Thesis"), false);
});

test("a paragraph under the heading counts as a body", () => {
  const cache = cacheFor(
    [["NVDA", 0], ["Thesis", 2], ["Notes", 5]],
    [["heading", 0], ["heading", 2], ["paragraph", 3], ["heading", 5]]
  );
  assert.equal(sectionHasBody(cache, "Thesis"), true);
});

test("body belonging to a later heading is not credited to this one", () => {
  // Thesis is empty; the paragraph sits under Notes.
  const cache = cacheFor(
    [["Thesis", 2], ["Notes", 3]],
    [["heading", 2], ["heading", 3], ["paragraph", 4]]
  );
  assert.equal(sectionHasBody(cache, "Thesis"), false);
});

test("the last heading in a note can still have a body", () => {
  const cache = cacheFor(
    [["Thesis", 2]],
    [["heading", 2], ["paragraph", 3]]
  );
  assert.equal(sectionHasBody(cache, "Thesis"), true);
});

test("heading match ignores case and surrounding whitespace", () => {
  const cache = cacheFor(
    [["  THESIS  ", 1]],
    [["heading", 1], ["paragraph", 2]]
  );
  assert.equal(sectionHasBody(cache, "thesis"), true);
});

test("a note with no such heading is neither present nor filled", () => {
  const cache = cacheFor([["Notes", 0]], [["heading", 0], ["paragraph", 1]]);
  assert.equal(sectionExists(cache, "Thesis"), false);
  assert.equal(sectionHasBody(cache, "Thesis"), false);
});

test("a note with no metadata at all is handled without throwing", () => {
  assert.equal(sectionExists(null, "Thesis"), false);
  assert.equal(sectionHasBody({}, "Thesis"), false);
});
