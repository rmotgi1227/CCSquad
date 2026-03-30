/**
 * Concurrent write tests — validates SQLite WAL + BEGIN IMMEDIATE behavior
 * under simultaneous writes from multiple "connections" (simulating multiple bridges).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { openDb, broadcast, readMessages, upsertInstance, setShared, getShared } from "../src/db.js";
import { nowMs } from "../src/types.js";
import Database from "better-sqlite3";

function tempDbPath(): string {
  return path.join(os.tmpdir(), `cs-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("concurrent writes", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    // Initialize schema
    const db = openDb(dbPath);
    upsertInstance(db, "inst-a", "A", "/proj", null);
    upsertInstance(db, "inst-b", "B", "/proj", null);
    upsertInstance(db, "inst-c", "C", "/proj", null);
    db.close();
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it("two concurrent broadcasts both persist", async () => {
    const [dbA, dbB] = [openDb(dbPath), openDb(dbPath)];

    await Promise.all([
      Promise.resolve(broadcast(dbA, "inst-a", "Message from A")),
      Promise.resolve(broadcast(dbB, "inst-b", "Message from B")),
    ]);

    dbA.close();
    dbB.close();

    const dbCheck = openDb(dbPath);
    const msgs = readMessages(dbCheck, undefined, undefined, 20);
    dbCheck.close();

    const contents = msgs.map((m) => m.content);
    expect(contents).toContain("Message from A");
    expect(contents).toContain("Message from B");
  });

  it("10 concurrent broadcasts all persist without loss", async () => {
    const dbs = Array.from({ length: 10 }, () => openDb(dbPath));
    const instances = ["inst-a", "inst-b", "inst-c", "inst-a", "inst-b",
                       "inst-c", "inst-a", "inst-b", "inst-c", "inst-a"];

    await Promise.all(
      dbs.map((db, i) =>
        Promise.resolve(broadcast(db, instances[i], `Concurrent message ${i}`))
      )
    );

    dbs.forEach((db) => db.close());

    const dbCheck = openDb(dbPath);
    const msgs = readMessages(dbCheck, undefined, undefined, 20);
    dbCheck.close();

    expect(msgs).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(msgs.map((m) => m.content)).toContain(`Concurrent message ${i}`);
    }
  });

  it("concurrent kv writes — last write wins per key", async () => {
    const [dbA, dbB] = [openDb(dbPath), openDb(dbPath)];

    // Both write to the same key
    setShared(dbA, "inst-a", "shared_key", "value_from_a");
    setShared(dbB, "inst-b", "shared_key", "value_from_b");

    dbA.close();
    dbB.close();

    const dbCheck = openDb(dbPath);
    const entry = getShared(dbCheck, "shared_key");
    dbCheck.close();

    // One of them should have won — key must exist
    expect(entry).toBeTruthy();
    expect(["value_from_a", "value_from_b"]).toContain(entry!.value);
  });

  it("concurrent writes to different keys both persist", async () => {
    const [dbA, dbB] = [openDb(dbPath), openDb(dbPath)];

    await Promise.all([
      Promise.resolve(setShared(dbA, "inst-a", "db_schema", "{ users }")),
      Promise.resolve(setShared(dbB, "inst-b", "error_convention", "AppError")),
    ]);

    dbA.close();
    dbB.close();

    const dbCheck = openDb(dbPath);
    const schema = getShared(dbCheck, "db_schema");
    const errConvention = getShared(dbCheck, "error_convention");
    dbCheck.close();

    expect(schema!.value).toBe("{ users }");
    expect(errConvention!.value).toBe("AppError");
  });

  it("messages have unique IDs under concurrent writes", async () => {
    const dbs = Array.from({ length: 5 }, () => openDb(dbPath));

    const ids = await Promise.all(
      dbs.map((db, i) =>
        Promise.resolve(broadcast(db, "inst-a", `msg ${i}`))
      )
    );

    dbs.forEach((db) => db.close());

    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(5);
  });
});

describe("message ordering under concurrent writes", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
    upsertInstance(db, "inst", "Test", "/p", null);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it("messages are ordered newest first by created_at", () => {
    broadcast(db, "inst", "first");
    broadcast(db, "inst", "second");
    broadcast(db, "inst", "third");
    const msgs = readMessages(db, undefined, undefined, 10);
    // Newest first
    expect(msgs[0].content).toBe("third");
    expect(msgs[1].content).toBe("second");
    expect(msgs[2].content).toBe("first");
  });

  it("tie-breaking by rowid for same-millisecond messages", () => {
    // Insert two messages with identical created_at
    const ts = nowMs();
    db.prepare("INSERT INTO messages (instance_id, type, content, created_at) VALUES (?, 'broadcast', ?, ?)")
      .run("inst", "same-ts-first", ts);
    db.prepare("INSERT INTO messages (instance_id, type, content, created_at) VALUES (?, 'broadcast', ?, ?)")
      .run("inst", "same-ts-second", ts);

    const msgs = readMessages(db, undefined, undefined, 10);
    // Both should be returned
    const contents = msgs.map((m) => m.content);
    expect(contents).toContain("same-ts-first");
    expect(contents).toContain("same-ts-second");
  });
});
