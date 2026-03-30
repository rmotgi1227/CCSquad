/**
 * Daemon client — used by both the bridge and CLI to talk to the daemon
 * via Unix socket (or TCP on Windows). Sends NDJSON requests, waits for response.
 */
import * as net from "net";
import * as fs from "fs";
import * as crypto from "crypto";
import {
  SOCKET_PATH,
  PORT_PATH,
  TCP_PORT_BASE,
  isWindows,
  DaemonRequest,
  DaemonResponse,
} from "./types.js";

const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;

function getAddress(): { type: "unix"; path: string } | { type: "tcp"; port: number } {
  if (isWindows()) {
    let port = TCP_PORT_BASE;
    if (fs.existsSync(PORT_PATH)) {
      const saved = parseInt(fs.readFileSync(PORT_PATH, "utf8").trim(), 10);
      if (!isNaN(saved)) port = saved;
    }
    return { type: "tcp", port };
  }
  return { type: "unix", path: SOCKET_PATH };
}

function connectSocket(): Promise<net.Socket> {
  const addr = getAddress();
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Connection to claude-squad daemon timed out"));
    }, CONNECT_TIMEOUT_MS);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    if (addr.type === "unix") {
      socket.connect(addr.path);
    } else {
      socket.connect(addr.port, "127.0.0.1");
    }
  });
}

export async function daemonRpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const socket = await connectSocket();
  const reqId = crypto.randomUUID();
  const req: DaemonRequest = { id: reqId, method, params };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`RPC timeout for method: ${method}`));
    }, REQUEST_TIMEOUT_MS);

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line) as DaemonResponse;
          if (resp.id === reqId) {
            clearTimeout(timer);
            socket.destroy();
            if (resp.error) {
              reject(new Error(resp.error));
            } else {
              resolve(resp.result);
            }
          }
        } catch {
          // ignore parse errors on other lines
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.write(JSON.stringify(req) + "\n");
  });
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    await daemonRpc("ping");
    return true;
  } catch {
    return false;
  }
}
