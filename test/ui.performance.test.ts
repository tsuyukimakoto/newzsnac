import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { moveSelection } from "../src/web/navigation.js";

test("100 keyboard moves across 10,000 items stay below 50ms at p95", () => {
  const durations: number[] = [];
  let selected = 0;
  for (let index = 0; index < 100; index += 1) {
    const startedAt = performance.now();
    selected = moveSelection(selected, 1, 10_000);
    durations.push(performance.now() - startedAt);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
  assert.equal(selected, 100);
  assert.ok(p95 < 50, `selection update p95 was ${p95.toFixed(3)}ms`);
});
