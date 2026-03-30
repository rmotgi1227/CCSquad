/**
 * --ensure-running: spawns the daemon if not already running.
 * Uses a file lock to prevent startup races.
 * Called from the PreToolUse hook.
 */
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { SQUAD_DIR, LOCK_PATH, SOCKET_PATH, isWindows } from "./types.js";
import { isDaemonRunning } from "./client.js";

const LOCK_TIMEOUT_MS = 10_000;
const SPAWN_WAIT_MS = 300;
const MAX_RETRIES = 15;

async function acquireLock(): Promise<() => void> {
  fs.mkdirSync(SQUAD_DIR, { recursive: true });
  const start = Date.now();

  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      // O_EXCL ensures only one process creates the lock file
      const fd = fs.openSync(LOCK_PATH, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(LOCK_PATH); } catch { /* best effort */ }
      };
    } catch {
      // Lock held by another process — wait and retry
      await sleep(50);
    }
  }
  throw new Error("Timed out waiting for daemon lock");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function ensureRunning(): Promise<void> {
  // Fast path: already running
  if (await isDaemonRunning()) return;

  const releaseLock = await acquireLock();
  try {
    // Double-check after acquiring lock (another process may have started it)
    if (await isDaemonRunning()) return;

    // Stale socket cleanup
    if (!isWindows() && fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }

    // Spawn the daemon detached
    const daemonScript = path.join(path.dirname(new URL(import.meta.url).pathname), "daemon.js");
    const daemonProcess = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    daemonProcess.unref();

    // Wait for daemon to be ready
    for (let i = 0; i < MAX_RETRIES; i++) {
      await sleep(SPAWN_WAIT_MS);
      if (await isDaemonRunning()) return;
    }

    throw new Error("Daemon failed to start within timeout");
  } finally {
    releaseLock();
  }
}
