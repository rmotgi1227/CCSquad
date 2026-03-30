import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

export const SQUAD_DIR = path.join(os.homedir(), ".claude-squad");
export const SOCKET_PATH = path.join(SQUAD_DIR, "server.sock");
export const LOCK_PATH = path.join(SQUAD_DIR, "server.lock");
export const DB_PATH = path.join(SQUAD_DIR, "state.db");
export const PORT_PATH = path.join(SQUAD_DIR, "port");
export const TCP_PORT_BASE = 38475;
export const TCP_PORT_MAX = 38499;

export const MAX_BROADCAST_BYTES = 10 * 1024; // 10KB
export const MAX_KV_VALUE_BYTES = 50 * 1024;  // 50KB
export const MAX_MESSAGES_LIMIT = 20;
export const DEFAULT_MESSAGES_LIMIT = 5;
export const STALE_INSTANCE_MS = 30 * 60 * 1000; // 30 minutes
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

export interface Instance {
  id: string;
  name: string;
  cwd: string;
  branch: string | null;
  last_seen: number; // millisecond epoch
}

export interface Message {
  id: number;
  instance_id: string;
  instance_name?: string; // joined
  type: "broadcast" | "ask" | "answer";
  content: string;
  tags: string[] | null;
  reply_to: number | null;
  created_at: number; // millisecond epoch
}

export interface KVEntry {
  key: string;
  value: string;
  set_by: string;
  updated_at: number;
}

export interface Standup {
  active_instances: Array<{ name: string; branch: string | null; cwd: string; last_seen: number }>;
  recent_messages: Array<{ from: string; type: string; content: string; created_at: number }>;
}

// Daemon RPC protocol (NDJSON over Unix socket)
export interface DaemonRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface DaemonResponse {
  id: string;
  result?: unknown;
  error?: string;
}

// Tool param types
export interface RegisterParams {
  name: string;
  cwd: string;
  branch?: string;
  pid: number;
  startup_ts: number;
}

export interface BroadcastParams {
  instance_id: string;
  content: string;
  tags?: string[];
}

export interface ReadMessagesParams {
  since?: number;
  tags?: string[];
  limit?: number;
}

export interface AskParams {
  instance_id: string;
  question: string;
  context?: string;
}

export interface AnswerParams {
  instance_id: string;
  question_id: number;
  answer: string;
}

export interface HeartbeatParams {
  instance_id: string;
  branch?: string;
}

export interface SetSharedParams {
  instance_id: string;
  key: string;
  value: string;
}

export interface GetSharedParams {
  key: string;
}

export function makeInstanceId(name: string, cwd: string, pid: number, startupTs: number): string {
  const raw = `${os.hostname()}:${name}:${cwd}:${pid}:${startupTs}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function nowMs(): number {
  return Date.now();
}

export function isWindows(): boolean {
  return process.platform === "win32";
}
