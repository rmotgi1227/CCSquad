#!/usr/bin/env node
/**
 * claude-squad CLI entry point
 * Usage:
 *   claude-squad                  → starts the MCP bridge (stdio)
 *   claude-squad --ensure-running → starts daemon if not running, then exits
 *   claude-squad status           → print active instances + recent messages
 *   claude-squad export           → dump channel history as markdown
 *   claude-squad daemon           → start the daemon directly (for debugging)
 */
import { nowMs } from "./types.js";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  if (args.includes("--ensure-running")) {
    const { ensureRunning } = await import("./ensure-running.js");
    await ensureRunning();
    process.exit(0);
  }

  if (args[0] === "daemon") {
    // Just run the daemon inline (for debugging or direct invocation)
    await import("./daemon.js");
    return;
  }

  if (args[0] === "status") {
    await runStatus();
    process.exit(0);
  }

  if (args[0] === "export") {
    await runExport();
    process.exit(0);
  }

  // Default: start MCP bridge
  const { ensureRunning } = await import("./ensure-running.js");
  await ensureRunning();
  await import("./bridge.js");
}

async function runStatus(): Promise<void> {
  const { daemonRpc, isDaemonRunning } = await import("./client.js");

  if (!(await isDaemonRunning())) {
    console.log("claude-squad: daemon not running");
    return;
  }

  const [instancesResult, messagesResult] = await Promise.all([
    daemonRpc("list_instances", {}) as Promise<{ instances: Array<{ name: string; branch?: string; cwd: string; last_seen: number }> }>,
    daemonRpc("read_messages", { limit: 10 }) as Promise<{ messages: Array<{ instance_name?: string; type: string; content: string; created_at: number; id: number }> }>,
  ]);

  console.log("\n=== claude-squad status ===\n");

  if (instancesResult.instances.length === 0) {
    console.log("No active instances.\n");
  } else {
    console.log("Active instances:");
    for (const inst of instancesResult.instances) {
      const branch = inst.branch ? `@${inst.branch}` : "";
      const age = inst.last_seen === 0 ? "offline" : formatAge(inst.last_seen);
      console.log(`  • ${inst.name}${branch} — ${inst.cwd} (${age})`);
    }
    console.log();
  }

  if (messagesResult.messages.length === 0) {
    console.log("No messages yet.");
  } else {
    console.log("Recent messages:");
    for (const msg of messagesResult.messages) {
      const age = formatAge(msg.created_at);
      const prefix = msg.type === "ask" ? `Q#${msg.id}` : msg.type === "answer" ? "  A" : "→";
      console.log(`  ${prefix} ${msg.instance_name || "unknown"} (${age}): ${msg.content.slice(0, 120)}`);
    }
    console.log();
  }
}

async function runExport(): Promise<void> {
  const { daemonRpc, isDaemonRunning } = await import("./client.js");

  if (!(await isDaemonRunning())) {
    console.log("claude-squad: daemon not running");
    return;
  }

  const messagesResult = await daemonRpc("read_messages", { limit: 20 }) as {
    messages: Array<{ instance_name?: string; type: string; content: string; created_at: number; id: number; tags?: string[] }>;
  };

  const lines: string[] = [
    "# claude-squad context export",
    `Generated: ${new Date().toISOString()}`,
    "",
  ];

  for (const msg of [...messagesResult.messages].reverse()) {
    const ts = new Date(msg.created_at).toISOString();
    const from = msg.instance_name || "unknown";
    const tags = msg.tags?.length ? ` [${msg.tags.join(", ")}]` : "";
    const prefix = msg.type === "ask" ? "**Question**" : msg.type === "answer" ? "**Answer**" : "**Broadcast**";
    lines.push(`## ${prefix} — ${from} (${ts})${tags}`);
    lines.push("");
    lines.push(msg.content);
    lines.push("");
  }

  console.log(lines.join("\n"));
}

function formatAge(ms: number): string {
  const diff = nowMs() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
