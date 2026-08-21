import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_MAP_CARD_GAP_X,
  SESSION_MAP_CARD_HEIGHT,
  SESSION_MAP_CARD_WIDTH,
  layoutSessionMap,
  sessionMapConnectorPath,
} from "./session-map-layout.ts";

function node(id) {
  return { id };
}

test("lays continuation turns horizontally and branches on separate lanes", () => {
  const positions = layoutSessionMap(
    [node("root"), node("continue"), node("branch")],
    [
      { source: "root", target: "continue" },
      { source: "root", target: "branch" },
    ],
  );
  const root = positions.get("root");
  const continuation = positions.get("continue");
  const branch = positions.get("branch");

  assert.equal(continuation.x, root.x + SESSION_MAP_CARD_WIDTH + SESSION_MAP_CARD_GAP_X);
  assert.equal(continuation.y, root.y);
  assert.ok(branch.y >= root.y + SESSION_MAP_CARD_HEIGHT);
});

test("builds a cubic connector from card centers", () => {
  assert.equal(
    sessionMapConnectorPath({ x: 10, y: 20 }, { x: 500, y: 120 }),
    "M 320 158 C 356 158, 464 258, 500 258",
  );
});
