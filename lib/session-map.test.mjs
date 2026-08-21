import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionMap } from "./session-map.ts";

function session(id, parentSessionId) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/repo",
    created: "2026-01-01T00:00:00.000Z",
    modified: `2026-01-0${id === "child" ? 2 : 1}T00:00:00.000Z`,
    messageCount: 0,
    firstMessage: "",
    parentSessionId,
  };
}

function message(id, parentId, role, content) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
    message: role === "assistant"
      ? { role, content: [{ type: "text", text: content }], model: "test", provider: "test" }
      : { role, content },
  };
}

test("projects every user/assistant turn and marks a diverging in-session branch", () => {
  const entries = [
    message("u1", null, "user", "First question"),
    message("a1", "u1", "assistant", "First answer"),
    message("u2", "a1", "user", "Second question"),
    message("a2", "u2", "assistant", "Second answer"),
    message("u3", "a1", "user", "Alternative question"),
    message("a3", "u3", "assistant", "Alternative answer"),
  ];
  const map = buildSessionMap([{ session: session("root"), entries, leafId: "a2" }], "root");

  assert.equal(map.nodes.length, 3);
  assert.equal(map.edges.length, 2);
  assert.equal(map.edges.every((edge) => edge.kind === "branch"), true);
  assert.equal(map.nodes.find((node) => node.id === map.activeNodeId)?.question, "Second question");
  assert.equal(map.activeNodeBySession.root, map.activeNodeId);
});

test("deduplicates inherited fork history and connects the child at the shared turn", () => {
  const inherited = [
    message("u1", null, "user", "Shared question"),
    message("a1", "u1", "assistant", "Shared answer"),
  ];
  const parentEntries = [
    ...inherited,
    message("u2", "a1", "user", "Parent continuation"),
    message("a2", "u2", "assistant", "Parent answer"),
  ];
  const childEntries = [
    ...inherited,
    message("uc", "a1", "user", "Fork continuation"),
    message("ac", "uc", "assistant", "Fork answer"),
  ];
  const map = buildSessionMap([
    { session: session("root"), entries: parentEntries, leafId: "a2" },
    { session: session("child", "root"), entries: childEntries, leafId: "ac" },
  ], "child");

  assert.equal(map.nodes.length, 3);
  const shared = map.nodes.find((node) => node.question === "Shared question");
  assert.deepEqual(new Set(shared.sessionIds), new Set(["root", "child"]));
  assert.equal(map.edges.filter((edge) => edge.source === shared.id).length, 2);
  assert.equal(map.nodes.find((node) => node.id === map.activeNodeId)?.question, "Fork continuation");
});

test("uses complete session metadata to preserve a fork family when ancestors are not projected", () => {
  const metadata = new Map([["grandchild", "missing-parent"], ["missing-parent", "root"]]);
  const inherited = [message("u1", null, "user", "Shared"), message("a1", "u1", "assistant", "Answer")];
  const map = buildSessionMap([
    { session: session("root"), entries: inherited, leafId: "a1" },
    { session: session("grandchild", "missing-parent"), entries: inherited, leafId: "a1" },
  ], "grandchild", metadata);

  assert.equal(map.nodes.length, 1);
  assert.deepEqual(new Set(map.nodes[0].sessionIds), new Set(["root", "grandchild"]));
});

test("keeps pending and completed card positions on one stable position key", () => {
  const pending = buildSessionMap([{
    session: session("root"),
    entries: [message("u1", null, "user", "Question")],
    leafId: "u1",
  }], "root");
  const complete = buildSessionMap([{
    session: session("root"),
    entries: [message("u1", null, "user", "Question"), message("a1", "u1", "assistant", "Answer")],
    leafId: "a1",
  }], "root");

  assert.equal(pending.nodes[0].positionKey, complete.nodes[0].positionKey);
  assert.notEqual(pending.nodes[0].id, complete.nodes[0].id);
});

test("finds the active node when the selected leaf has structural descendants", () => {
  const entries = [
    message("u1", null, "user", "First"),
    message("a1", "u1", "assistant", "First answer"),
    message("u2", "a1", "user", "Second"),
    message("a2", "u2", "assistant", "Second answer"),
  ];
  const map = buildSessionMap([{ session: session("root"), entries, leafId: "a1" }], "root");

  assert.equal(map.nodes.find((node) => node.id === map.activeNodeId)?.question, "First");
});

test("keeps the active recent tail when a session exceeds the node cap", () => {
  const entries = [];
  let parentId = null;
  for (let index = 0; index < 320; index += 1) {
    const user = message(`u${index}`, parentId, "user", `Question ${index}`);
    const assistant = message(`a${index}`, user.id, "assistant", `Answer ${index}`);
    entries.push(user, assistant);
    parentId = assistant.id;
  }
  const map = buildSessionMap([{ session: session("root"), entries, leafId: parentId }], "root");

  assert.equal(map.truncated, true);
  assert.equal(map.nodes.some((node) => node.id === map.activeNodeId), true);
  assert.equal(map.nodes.find((node) => node.id === map.activeNodeId)?.question, "Question 319");
});

test("ignores malformed message shapes without hiding valid turns", () => {
  const entries = [
    { type: "message", id: "bad", parentId: null, timestamp: "", message: null },
    message("u1", "bad", "user", "Valid"),
    { type: "message", id: "a1", parentId: "u1", timestamp: "", message: { role: "assistant", content: [null], model: "x", provider: "x" } },
  ];
  const map = buildSessionMap([{ session: session("root"), entries, leafId: "a1" }], "root");

  assert.equal(map.nodes.length, 1);
  assert.equal(map.nodes[0].question, "Valid");
});

test("assigns alternate-answer position keys independently of active leaf order", () => {
  const entries = [
    message("u1", null, "user", "Question"),
    message("a1", "u1", "assistant", "Answer A"),
    message("a2", "u1", "assistant", "Answer B"),
  ];
  const first = buildSessionMap([{ session: session("root"), entries, leafId: "a1" }], "root");
  const second = buildSessionMap([{ session: session("root"), entries, leafId: "a2" }], "root");
  const firstKeys = new Map(first.nodes.map((node) => [node.answerEntryId, node.positionKey]));
  const secondKeys = new Map(second.nodes.map((node) => [node.answerEntryId, node.positionKey]));

  assert.deepEqual(firstKeys, secondKeys);
});

test("keeps alternate answers to one question as separate cards", () => {
  const entries = [
    message("u1", null, "user", "Question"),
    message("a1", "u1", "assistant", "Answer A"),
    message("a2", "u1", "assistant", "Answer B"),
  ];
  const map = buildSessionMap([{ session: session("root"), entries, leafId: "a2" }], "root");

  assert.equal(map.nodes.length, 2);
  assert.equal(new Set(map.nodes.map((node) => node.positionKey)).size, 2);
  assert.deepEqual(new Set(map.nodes.map((node) => node.answer)), new Set(["Answer A", "Answer B"]));
});
