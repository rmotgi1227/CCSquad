import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import {
  openDb,
  upsertInstance,
  heartbeat,
  markOffline,
  listInstances,
  getActiveInstances,
  broadcast,
  ask,
  answer,
  readMessages,
  setShared,
  getShared,
  buildStandup,
  pruneOldMessages,
} from "../src/db.js";
import { nowMs, makeInstanceId, STALE_INSTANCE_MS } from "../src/types.js";

function tempDbPath(): string {
  return path.join(os.tmpdir(), `cs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("openDb", () => {
  it("creates schema tables", () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("instances");
    expect(names).toContain("messages");
    expect(names).toContain("kv");
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("creates idx_messages_created_at index", () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_created_at'").get();
    expect(idx).toBeTruthy();
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("is idempotent — calling openDb twice doesn't error", () => {
    const dbPath = tempDbPath();
    const db1 = openDb(dbPath);
    db1.close();
    const db2 = openDb(dbPath);
    db2.close();
    fs.unlinkSync(dbPath);
  });
});

describe("instances", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("upserts an instance", () => {
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "main");
    const instances = listInstances(db);
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe("Frontend");
    expect(instances[0].branch).toBe("main");
  });

  it("updates existing instance on upsert", () => {
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "main");
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "feature/auth");
    const instances = listInstances(db);
    expect(instances).toHaveLength(1);
    expect(instances[0].branch).toBe("feature/auth");
  });

  it("heartbeat updates last_seen and branch", () => {
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "main");
    const before = listInstances(db)[0].last_seen;
    // Small delay to ensure timestamp difference
    heartbeat(db, "abc", "feature/new");
    const after = listInstances(db)[0];
    expect(after.last_seen).toBeGreaterThanOrEqual(before);
    expect(after.branch).toBe("feature/new");
  });

  it("heartbeat without branch doesn't clear branch", () => {
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "main");
    heartbeat(db, "abc");
    const inst = listInstances(db)[0];
    expect(inst.branch).toBe("main");
  });

  it("markOffline sets last_seen to 0", () => {
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "main");
    markOffline(db, "abc");
    const inst = db.prepare("SELECT last_seen FROM instances WHERE id = 'abc'").get() as { last_seen: number };
    expect(inst.last_seen).toBe(0);
  });

  it("getActiveInstances excludes stale instances", () => {
    upsertInstance(db, "active", "Active", "/a", "main");
    // Manually insert stale instance
    const staleTs = nowMs() - STALE_INSTANCE_MS - 1000;
    db.prepare("INSERT INTO instances (id, name, cwd, branch, last_seen) VALUES (?, ?, ?, ?, ?)")
      .run("stale", "Stale", "/b", "main", staleTs);
    const active = getActiveInstances(db);
    expect(active.map((i) => i.id)).toContain("active");
    expect(active.map((i) => i.id)).not.toContain("stale");
  });

  it("makeInstanceId is unique for different pids", () => {
    const id1 = makeInstanceId("Frontend", "/project", 1234, 1000);
    const id2 = makeInstanceId("Frontend", "/project", 1235, 1000);
    expect(id1).not.toBe(id2);
  });

  it("makeInstanceId is unique for different startup timestamps", () => {
    const id1 = makeInstanceId("Frontend", "/project", 1234, 1000);
    const id2 = makeInstanceId("Frontend", "/project", 1234, 1001);
    expect(id1).not.toBe(id2);
  });

  it("two instances in same cwd get different ids", () => {
    const id1 = makeInstanceId("Frontend", "/project", 100, nowMs());
    const id2 = makeInstanceId("Frontend", "/project", 101, nowMs());
    upsertInstance(db, id1, "Frontend", "/project", "main");
    upsertInstance(db, id2, "Frontend", "/project", "main");
    const instances = listInstances(db);
    expect(instances).toHaveLength(2);
  });
});

describe("messages", () => {
  let db: Database.Database;
  let dbPath: string;
  const instanceId = "test-instance";

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
    upsertInstance(db, instanceId, "TestInstance", "/project", "main");
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("broadcast saves a message", () => {
    const id = broadcast(db, instanceId, "Hello squad");
    expect(id).toBeGreaterThan(0);
    const msgs = readMessages(db);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Hello squad");
    expect(msgs[0].type).toBe("broadcast");
  });

  it("broadcast with tags saves tags as JSON array", () => {
    broadcast(db, instanceId, "DB schema updated", ["db-schema", "breaking"]);
    const msgs = readMessages(db);
    expect(msgs[0].tags).toEqual(["db-schema", "breaking"]);
  });

  it("broadcast rejects content over 10KB", () => {
    const big = "x".repeat(10 * 1024 + 1);
    expect(() => broadcast(db, instanceId, big)).toThrow(/too large/);
  });

  it("ask saves a question", () => {
    const id = ask(db, instanceId, "What DB are we using?");
    expect(id).toBeGreaterThan(0);
    const msgs = readMessages(db);
    expect(msgs[0].type).toBe("ask");
  });

  it("answer saves a reply to a valid question", () => {
    const questionId = ask(db, instanceId, "What DB are we using?");
    const answerId = answer(db, instanceId, questionId, "Postgres with Prisma");
    expect(answerId).toBeGreaterThan(0);
    const msgs = readMessages(db, undefined, undefined, 20);
    const ans = msgs.find((m) => m.id === answerId);
    expect(ans).toBeTruthy();
    expect(ans!.reply_to).toBe(questionId);
  });

  it("answer rejects non-existent question_id", () => {
    expect(() => answer(db, instanceId, 9999, "answer")).toThrow(/not found/);
  });

  it("answer rejects replying to a broadcast", () => {
    const broadcastId = broadcast(db, instanceId, "hello");
    expect(() => answer(db, instanceId, broadcastId, "this should fail")).toThrow(/not a question/);
  });

  it("readMessages respects default limit of 5", () => {
    for (let i = 0; i < 10; i++) broadcast(db, instanceId, `msg ${i}`);
    const msgs = readMessages(db);
    expect(msgs).toHaveLength(5);
  });

  it("readMessages respects custom limit", () => {
    for (let i = 0; i < 10; i++) broadcast(db, instanceId, `msg ${i}`);
    const msgs = readMessages(db, undefined, undefined, 8);
    expect(msgs).toHaveLength(8);
  });

  it("readMessages caps at max 20", () => {
    for (let i = 0; i < 30; i++) broadcast(db, instanceId, `msg ${i}`);
    const msgs = readMessages(db, undefined, undefined, 100);
    expect(msgs).toHaveLength(20);
  });

  it("readMessages filters by since timestamp", async () => {
    broadcast(db, instanceId, "old message");
    const mid = nowMs();
    // Small delay to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 5));
    broadcast(db, instanceId, "new message");
    const msgs = readMessages(db, mid);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("new message");
  });

  it("readMessages filters by tags", () => {
    broadcast(db, instanceId, "db change", ["db-schema"]);
    broadcast(db, instanceId, "auth change", ["auth"]);
    broadcast(db, instanceId, "no tags");
    const msgs = readMessages(db, undefined, ["db-schema"], 20);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("db change");
  });

  it("readMessages returns messages newest first", () => {
    broadcast(db, instanceId, "first");
    broadcast(db, instanceId, "second");
    broadcast(db, instanceId, "third");
    const msgs = readMessages(db, undefined, undefined, 10);
    expect(msgs[0].content).toBe("third");
    expect(msgs[2].content).toBe("first");
  });
});

describe("kv store", () => {
  let db: Database.Database;
  let dbPath: string;
  const instanceId = "kv-test";

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
    upsertInstance(db, instanceId, "KVTest", "/project", null);
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("set and get a key", () => {
    setShared(db, instanceId, "db_schema", "{ users: { id, email } }");
    const entry = getShared(db, "db_schema");
    expect(entry).toBeTruthy();
    expect(entry!.value).toBe("{ users: { id, email } }");
    expect(entry!.set_by).toBe(instanceId);
  });

  it("update overwrites existing key", () => {
    setShared(db, instanceId, "convention", "AppError");
    setShared(db, instanceId, "convention", "HttpError");
    const entry = getShared(db, "convention");
    expect(entry!.value).toBe("HttpError");
  });

  it("returns undefined for missing key", () => {
    const entry = getShared(db, "nonexistent");
    expect(entry).toBeUndefined();
  });

  it("rejects values over 50KB", () => {
    const big = "x".repeat(50 * 1024 + 1);
    expect(() => setShared(db, instanceId, "big_key", big)).toThrow(/too large/);
  });

  it("accepts values at exactly 50KB", () => {
    const exact = "x".repeat(50 * 1024);
    expect(() => setShared(db, instanceId, "exact_key", exact)).not.toThrow();
  });
});

describe("standup", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("returns empty standup when no data", () => {
    const standup = buildStandup(db);
    expect(standup.active_instances).toHaveLength(0);
    expect(standup.recent_messages).toHaveLength(0);
  });

  it("includes active instances and recent messages", () => {
    upsertInstance(db, "a1", "Frontend", "/proj", "main");
    upsertInstance(db, "a2", "Backend", "/proj", "main");
    broadcast(db, "a1", "Using tRPC");
    const standup = buildStandup(db);
    expect(standup.active_instances).toHaveLength(2);
    expect(standup.recent_messages).toHaveLength(1);
    expect(standup.recent_messages[0].content).toBe("Using tRPC");
  });

  it("caps message content at 200 chars in standup", () => {
    upsertInstance(db, "a1", "Frontend", "/proj", null);
    broadcast(db, "a1", "x".repeat(300));
    const standup = buildStandup(db);
    expect(standup.recent_messages[0].content.length).toBe(200);
  });

  it("returns at most 5 recent messages", () => {
    upsertInstance(db, "a1", "Frontend", "/proj", null);
    for (let i = 0; i < 10; i++) broadcast(db, "a1", `msg ${i}`);
    const standup = buildStandup(db);
    expect(standup.recent_messages).toHaveLength(5);
  });
});

describe("pruneOldMessages", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
    upsertInstance(db, "inst", "Test", "/p", null);
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("deletes messages older than cutoff", () => {
    // Insert old message manually
    const oldTs = nowMs() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    db.prepare("INSERT INTO messages (instance_id, type, content, created_at) VALUES (?, 'broadcast', ?, ?)")
      .run("inst", "old msg", oldTs);
    broadcast(db, "inst", "new msg");

    pruneOldMessages(db);
    const msgs = readMessages(db, undefined, undefined, 20);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("new msg");
  });

  it("keeps messages newer than cutoff", () => {
    broadcast(db, "inst", "recent");
    pruneOldMessages(db);
    const msgs = readMessages(db, undefined, undefined, 20);
    expect(msgs).toHaveLength(1);
  });
});
