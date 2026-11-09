import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TREE_LINKS, nonLinearTreeLinks } from "./tree-links.ts";

const lane = (sessionId, nodes) => ({ session: { id: sessionId }, model: null, truncated: false, nodes: nodes.map((node) => ({ ...node, sessionId, entryId: node.id, kind: "answer" })) });

test("a plain chain needs no drawn link", () => {
  assert.deepEqual(nonLinearTreeLinks([lane("s", [{ id: "a", parentId: null }, { id: "b", parentId: "a" }, { id: "c", parentId: "b" }])]), []);
});

test("a branch away from the previous entry draws one link", () => {
  assert.deepEqual(nonLinearTreeLinks([lane("s", [{ id: "a", parentId: null }, { id: "b", parentId: "a" }, { id: "c", parentId: "a" }])]), [{ laneSessionId: "s", parentId: "a", nodeId: "c" }]);
});

test("a join back onto an earlier entry is drawn", () => {
  assert.deepEqual(nonLinearTreeLinks([lane("s", [{ id: "a", parentId: null }, { id: "b", parentId: "a" }, { id: "c", parentId: "b" }, { id: "d", parentId: "b" }])]), [{ laneSessionId: "s", parentId: "b", nodeId: "d" }]);
});

test("parents outside the lane are left to the dispatch and return edges", () => {
  assert.deepEqual(nonLinearTreeLinks([lane("s", [{ id: "a", parentId: "other:z" }, { id: "b", parentId: "a" }])]), []);
});

test("each lane keeps its own links and its own session colour source", () => {
  assert.deepEqual(nonLinearTreeLinks([
    lane("s1", [{ id: "a", parentId: null }, { id: "b", parentId: "a" }, { id: "c", parentId: "a" }]),
    lane("s2", [{ id: "x", parentId: null }, { id: "y", parentId: "x" }, { id: "z", parentId: "x" }]),
  ]), [
    { laneSessionId: "s1", parentId: "a", nodeId: "c" },
    { laneSessionId: "s2", parentId: "x", nodeId: "z" },
  ]);
});

test("the drawn links stay bounded on a very wide graph", () => {
  const nodes = [{ id: "a", parentId: null }];
  for (let index = 0; index < MAX_TREE_LINKS + 40; index += 1) nodes.push({ id: `n${index}`, parentId: "a" });
  assert.equal(nonLinearTreeLinks([lane("s", nodes)]).length, MAX_TREE_LINKS);
});
