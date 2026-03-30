import Database from "better-sqlite3";
import * as fs from "fs";
import {
  DB_PATH,
  SQUAD_DIR,
  SQLITE_BUSY_TIMEOUT_MS,
  STALE_INSTANCE_MS,
  Instance,
  Message,
  KVEntry,
  Standup,
  DEFAULT_MESSAGES_LIMIT,
  MAX_MESSAGES_LIMIT,
  MAX_BROADCAST_BYTES,
  MAX_KV_VALUE_BYTES,
  nowMs,
} from "./types.js";

export function openDb(dbPath = DB_PATH): Database.Database {
  fs.mkdirSync(SQUAD_DIR, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = " + SQLITE_BUSY_TIMEOUT_MS);
  db.pragma("foreign_keys = ON");
  initSchema(db);
  purgeStaleInstances(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      branch TEXT,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('broadcast','ask','answer')),
      content TEXT NOT NULL,
      tags TEXT,
      reply_to INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      set_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function purgeStaleInstances(db: Database.Database): void {
  const cutoff = nowMs() - STALE_INSTANCE_MS;
  db.prepare("DELETE FROM instances WHERE last_seen > 0 AND last_seen < ?").run(cutoff);
}

// ── Instances ────────────────────────────────────────────────────────────────

export function upsertInstance(
  db: Database.Database,
  id: string,
  name: string,
  cwd: string,
  branch: string | null
): void {
  db.prepare(`
    INSERT INTO instances (id, name, cwd, branch, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      cwd = excluded.cwd,
      branch = excluded.branch,
      last_seen = excluded.last_seen
  `).run(id, name, cwd, branch ?? null, nowMs());
}

export function heartbeat(
  db: Database.Database,
  instanceId: string,
  branch?: string
): void {
  const updates: string[] = ["last_seen = ?"];
  const values: unknown[] = [nowMs()];
  if (branch !== undefined) {
    updates.push("branch = ?");
    values.push(branch);
  }
  values.push(instanceId);
  db.prepare(`UPDATE instances SET ${updates.join(", ")} WHERE id = ?`).run(...values);
}

export function markOffline(db: Database.Database, instanceId: string): void {
  db.prepare("UPDATE instances SET last_seen = 0 WHERE id = ?").run(instanceId);
}

export function listInstances(db: Database.Database): Instance[] {
  const cutoff = nowMs() - STALE_INSTANCE_MS;
  return db
    .prepare("SELECT * FROM instances WHERE last_seen > ? OR last_seen = 0 ORDER BY last_seen DESC")
    .all(cutoff) as Instance[];
}

export function getActiveInstances(db: Database.Database): Instance[] {
  const cutoff = nowMs() - STALE_INSTANCE_MS;
  return db
    .prepare("SELECT * FROM instances WHERE last_seen >= ? ORDER BY last_seen DESC")
    .all(cutoff) as Instance[];
}

// ── Messages ─────────────────────────────────────────────────────────────────

export function broadcast(
  db: Database.Database,
  instanceId: string,
  content: string,
  tags?: string[]
): number {
  if (Buffer.byteLength(content, "utf8") > MAX_BROADCAST_BYTES) {
    throw new Error(`Message too large (max ${MAX_BROADCAST_BYTES / 1024}KB)`);
  }
  const tagsJson = tags && tags.length > 0 ? JSON.stringify(tags) : null;
  const result = db.prepare(`
    INSERT INTO messages (instance_id, type, content, tags, reply_to, created_at)
    VALUES (?, 'broadcast', ?, ?, NULL, ?)
  `).run(instanceId, content, tagsJson, nowMs());
  return result.lastInsertRowid as number;
}

export function ask(
  db: Database.Database,
  instanceId: string,
  question: string,
  context?: string
): number {
  const content = context ? `${question}\n\nContext: ${context}` : question;
  if (Buffer.byteLength(content, "utf8") > MAX_BROADCAST_BYTES) {
    throw new Error(`Question too large (max ${MAX_BROADCAST_BYTES / 1024}KB)`);
  }
  const result = db.prepare(`
    INSERT INTO messages (instance_id, type, content, tags, reply_to, created_at)
    VALUES (?, 'ask', ?, NULL, NULL, ?)
  `).run(instanceId, content, nowMs());
  return result.lastInsertRowid as number;
}

export function answer(
  db: Database.Database,
  instanceId: string,
  questionId: number,
  answerText: string
): number {
  // Validate reply_to references an existing ask
  const target = db.prepare(
    "SELECT id, type FROM messages WHERE id = ?"
  ).get(questionId) as { id: number; type: string } | undefined;

  if (!target) {
    throw new Error(`Question ID ${questionId} not found`);
  }
  if (target.type !== "ask") {
    throw new Error(`Message ${questionId} is not a question (type: ${target.type})`);
  }

  if (Buffer.byteLength(answerText, "utf8") > MAX_BROADCAST_BYTES) {
    throw new Error(`Answer too large (max ${MAX_BROADCAST_BYTES / 1024}KB)`);
  }

  const result = db.prepare(`
    INSERT INTO messages (instance_id, type, content, tags, reply_to, created_at)
    VALUES (?, 'answer', ?, NULL, ?, ?)
  `).run(instanceId, answerText, questionId, nowMs());
  return result.lastInsertRowid as number;
}

export function readMessages(
  db: Database.Database,
  since?: number,
  tags?: string[],
  limit?: number
): Message[] {
  const effectiveLimit = Math.min(limit ?? DEFAULT_MESSAGES_LIMIT, MAX_MESSAGES_LIMIT);

  let query = `
    SELECT m.*, i.name AS instance_name
    FROM messages m
    LEFT JOIN instances i ON m.instance_id = i.id
  `;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (since !== undefined) {
    conditions.push("m.created_at > ?");
    params.push(since);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY m.created_at DESC, m.id DESC LIMIT ?";
  params.push(effectiveLimit);

  const rows = db.prepare(query).all(...params) as Array<Message & { tags: string | null }>;

  // Filter by tags in application layer (tags stored as JSON)
  let results = rows.map((r) => ({
    ...r,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : null,
  }));

  if (tags && tags.length > 0) {
    results = results.filter(
      (r) => r.tags && tags.some((t) => r.tags!.includes(t))
    );
  }

  return results;
}

// ── KV Store ─────────────────────────────────────────────────────────────────

export function setShared(
  db: Database.Database,
  instanceId: string,
  key: string,
  value: string
): void {
  if (Buffer.byteLength(value, "utf8") > MAX_KV_VALUE_BYTES) {
    throw new Error(`KV value too large (max ${MAX_KV_VALUE_BYTES / 1024}KB). Use broadcast for large context.`);
  }
  db.prepare(`
    INSERT INTO kv (key, value, set_by, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      set_by = excluded.set_by,
      updated_at = excluded.updated_at
  `).run(key, value, instanceId, nowMs());
}

export function getShared(
  db: Database.Database,
  key: string
): KVEntry | undefined {
  return db.prepare("SELECT * FROM kv WHERE key = ?").get(key) as KVEntry | undefined;
}

// ── Standup ───────────────────────────────────────────────────────────────────

export function buildStandup(db: Database.Database): Standup {
  const active = getActiveInstances(db);
  const recent = db.prepare(`
    SELECT m.type, m.content, m.created_at, i.name AS instance_name
    FROM messages m
    LEFT JOIN instances i ON m.instance_id = i.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 5
  `).all() as Array<{ type: string; content: string; created_at: number; instance_name: string }>;

  return {
    active_instances: active.map((i) => ({
      name: i.name,
      branch: i.branch,
      cwd: i.cwd,
      last_seen: i.last_seen,
    })),
    recent_messages: recent.map((r) => ({
      from: r.instance_name || "unknown",
      type: r.type,
      content: r.content.slice(0, 200), // cap standup content at 200 chars per message
      created_at: r.created_at,
    })),
  };
}

// ── Pruning ───────────────────────────────────────────────────────────────────

export function pruneOldMessages(db: Database.Database, olderThanMs = 7 * 24 * 60 * 60 * 1000): void {
  const cutoff = nowMs() - olderThanMs;
  db.prepare("DELETE FROM messages WHERE created_at < ?").run(cutoff);
}
