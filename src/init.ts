/**
 * ccsquad init command
 * Sets up MCP registration, injects CLAUDE.md coordination block, optionally status line.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { ensureRunning } from "./ensure-running.js";

export interface InitOptions {
  update?: boolean;
  mode?: "passive" | "aggressive";
  statusLine?: boolean;
  // Overridable paths for testing
  claudeJsonPath?: string;
  claudeMdPath?: string;
  settingsJsonPath?: string;
  squadDir?: string;
}

const SENTINEL_START_RE = /<!-- ccsquad:start(?: mode=(\w+))? -->/;
const SENTINEL_END = "<!-- ccsquad:end -->";

const PASSIVE_BLOCK = (mode = "passive") =>
  `<!-- ccsquad:start mode=${mode} -->
## ccsquad coordination

On session start: call \`list_instances\` and \`read_messages\` to catch up on squad activity.
Answer squad questions when asked. Broadcast major architectural decisions (new DB schema,
error handling pattern, shared utility, API contract change).
<!-- ccsquad:end -->`;

const AGGRESSIVE_BLOCK =
  `<!-- ccsquad:start mode=aggressive -->
## ccsquad coordination

On session start: call \`list_instances\` and \`read_messages\`.
Before any of these: broadcast intent first — schema changes, new shared utilities,
API design decisions, error handling patterns.
Examples: adding a DB table, creating a shared util function, choosing an HTTP error shape.
After completing significant work: broadcast what you built and conventions established.
Answer squad questions proactively.
<!-- ccsquad:end -->`;

function getTemplate(mode: "passive" | "aggressive"): string {
  return mode === "aggressive" ? AGGRESSIVE_BLOCK : PASSIVE_BLOCK(mode);
}

function findClaudeMd(overridePath?: string): string {
  if (overridePath) return overridePath;
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return path.join(root, "CLAUDE.md");
  } catch {
    return path.join(process.cwd(), "CLAUDE.md");
  }
}

function defaultClaudeJsonPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

function defaultSettingsJsonPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function writeJsonAtomic(filePath: string, data: Record<string, unknown>): void {
  const tmp = filePath + ".tmp";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function detectExistingBlock(content: string): { found: boolean; start: number; end: number; mode?: string } {
  const match = SENTINEL_START_RE.exec(content);
  if (!match) return { found: false, start: -1, end: -1 };
  const endIdx = content.indexOf(SENTINEL_END, match.index);
  if (endIdx === -1) return { found: false, start: -1, end: -1 };
  return {
    found: true,
    start: match.index,
    end: endIdx + SENTINEL_END.length,
    mode: match[1] as "passive" | "aggressive" | undefined,
  };
}

export async function runInit(opts: InitOptions = {}): Promise<void> {
  const claudeJsonPath = opts.claudeJsonPath ?? defaultClaudeJsonPath();
  const settingsJsonPath = opts.settingsJsonPath ?? defaultSettingsJsonPath();
  const mode = opts.mode ?? "passive";
  const modified: string[] = [];

  // Step 1: Register MCP server in ~/.claude.json (atomic write)
  try {
    const cfg = readJson(claudeJsonPath);
    const mcpServers = (cfg.mcpServers as Record<string, unknown>) ?? {};
    if (!mcpServers["ccsquad"] || opts.update) {
      mcpServers["ccsquad"] = { command: "ccsquad", args: [] };
      cfg.mcpServers = mcpServers;
      writeJsonAtomic(claudeJsonPath, cfg);
      modified.push(claudeJsonPath);
      console.log(`✓ MCP server registered in ${claudeJsonPath}`);
    } else {
      console.log(`  MCP server already registered`);
    }
  } catch (err) {
    console.error(`  Could not update ${claudeJsonPath}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  Manual step: add to ~/.claude.json → mcpServers.ccsquad: { command: "ccsquad", args: [] }`);
  }

  // Step 2+3: Inject CLAUDE.md coordination block
  const claudeMdPath = findClaudeMd(opts.claudeMdPath);
  try {
    const existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, "utf8") : "";
    const detected = detectExistingBlock(existing);

    let newContent: string;
    if (detected.found) {
      if (!opts.update) {
        console.log(`  CLAUDE.md already has ccsquad block. Run with --update to refresh.`);
        newContent = existing; // no change
      } else {
        const effectiveMode = opts.mode ?? (detected.mode as "passive" | "aggressive") ?? "passive";
        const block = getTemplate(effectiveMode);
        newContent = existing.slice(0, detected.start) + block + existing.slice(detected.end);
        if (newContent !== existing) {
          modified.push(claudeMdPath);
          console.log(`✓ CLAUDE.md block updated (mode: ${effectiveMode})`);
        }
      }
    } else {
      const block = getTemplate(mode);
      newContent = existing ? existing.trimEnd() + "\n\n" + block + "\n" : block + "\n";
      modified.push(claudeMdPath);
      console.log(`✓ CLAUDE.md updated at ${claudeMdPath} (mode: ${mode})`);
    }

    if (newContent !== existing || !fs.existsSync(claudeMdPath)) {
      fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
      fs.writeFileSync(claudeMdPath, newContent, "utf8");
    }
  } catch (err) {
    console.error(`  Could not update ${claudeMdPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 4: Inject status line hook (optional)
  if (opts.statusLine) {
    const squadDir = opts.squadDir ?? path.join(os.homedir(), ".ccsquad");
    const scriptPath = path.join(squadDir, "statusline.sh");
    try {
      fs.mkdirSync(squadDir, { recursive: true });
      fs.writeFileSync(
        scriptPath,
        `#!/bin/bash\ncount=$(cat "${squadDir}/status-cache" 2>/dev/null || echo "0")\n[ "$count" -gt 0 ] && echo "● $count squad msg$([ \\"$count\\" -ne 1 ] && echo s)" || true\n`,
        { encoding: "utf8", mode: 0o755 }
      );

      const settings = readJson(settingsJsonPath);
      const hooks = (settings.hooks as Record<string, unknown>) ?? {};
      const postToolUse = (hooks["PostToolUse"] as unknown[]) ?? [];

      const alreadyInjected = postToolUse.some(
        (h: unknown) =>
          typeof h === "object" &&
          h !== null &&
          (h as Record<string, unknown>)["hooks"] instanceof Array &&
          ((h as Record<string, unknown>)["hooks"] as unknown[]).some(
            (inner: unknown) =>
              typeof inner === "object" &&
              inner !== null &&
              (inner as Record<string, unknown>)["command"] === scriptPath
          )
      );

      if (!alreadyInjected) {
        postToolUse.push({
          matcher: "",
          hooks: [{ type: "command", command: scriptPath, timeout: 200 }],
        });
        hooks["PostToolUse"] = postToolUse;
        settings.hooks = hooks;
        writeJsonAtomic(settingsJsonPath, settings);
        modified.push(settingsJsonPath);
        console.log(`✓ Status line hook injected into ${settingsJsonPath}`);
      }
    } catch (err) {
      console.error(`  Could not inject status line hook: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 5: Start daemon if not running
  try {
    await ensureRunning();
    console.log(`✓ Daemon running`);
  } catch (err) {
    console.error(`  Warning: could not start daemon: ${err instanceof Error ? err.message : String(err)}`);
    if (modified.length > 0) {
      console.error(`  Files already modified: ${modified.join(", ")}`);
      console.error(`  Run 'ccsquad --ensure-running' to start the daemon manually.`);
    }
  }

  console.log(`\nccsquad ready. Open Claude Code in any worktree.`);
}
