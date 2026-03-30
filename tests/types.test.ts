/**
 * Tests for utility functions in types.ts
 */
import { describe, it, expect } from "vitest";
import { makeInstanceId, nowMs, isWindows } from "../src/types.js";

describe("makeInstanceId", () => {
  it("returns a 16-char hex string", () => {
    const id = makeInstanceId("Frontend", "/project", 1234, 1000000);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("same inputs produce same id", () => {
    const id1 = makeInstanceId("Frontend", "/project", 1234, 1000000);
    const id2 = makeInstanceId("Frontend", "/project", 1234, 1000000);
    expect(id1).toBe(id2);
  });

  it("different names produce different ids", () => {
    const id1 = makeInstanceId("Frontend", "/project", 1234, 1000000);
    const id2 = makeInstanceId("Backend", "/project", 1234, 1000000);
    expect(id1).not.toBe(id2);
  });

  it("different cwds produce different ids", () => {
    const id1 = makeInstanceId("Frontend", "/project-a", 1234, 1000000);
    const id2 = makeInstanceId("Frontend", "/project-b", 1234, 1000000);
    expect(id1).not.toBe(id2);
  });

  it("different pids produce different ids", () => {
    const id1 = makeInstanceId("Frontend", "/project", 1234, 1000000);
    const id2 = makeInstanceId("Frontend", "/project", 9999, 1000000);
    expect(id1).not.toBe(id2);
  });

  it("different startup timestamps produce different ids", () => {
    const id1 = makeInstanceId("Frontend", "/project", 1234, 1000000);
    const id2 = makeInstanceId("Frontend", "/project", 1234, 1000001);
    expect(id1).not.toBe(id2);
  });

  it("all 4 changing params produce all different ids", () => {
    const ids = new Set([
      makeInstanceId("A", "/p1", 1, 1),
      makeInstanceId("B", "/p1", 1, 1),
      makeInstanceId("A", "/p2", 1, 1),
      makeInstanceId("A", "/p1", 2, 1),
      makeInstanceId("A", "/p1", 1, 2),
    ]);
    expect(ids.size).toBe(5);
  });
});

describe("nowMs", () => {
  it("returns a number in milliseconds", () => {
    const ts = nowMs();
    expect(typeof ts).toBe("number");
    expect(ts).toBeGreaterThan(1_000_000_000_000); // after Jan 2001
  });

  it("two consecutive calls are non-decreasing", () => {
    const t1 = nowMs();
    const t2 = nowMs();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});

describe("isWindows", () => {
  it("returns a boolean", () => {
    expect(typeof isWindows()).toBe("boolean");
  });
});
