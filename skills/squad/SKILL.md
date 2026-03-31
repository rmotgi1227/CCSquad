---
name: squad
version: 1.1.0
description: |
  Set up ccsquad for this project — wires up MCP, injects CLAUDE.md coordination block,
  shows squad status. Use when asked to "set up squad", "add ccsquad", "coordinate instances",
  or "/squad". (ccsquad)
allowed-tools:
  - Bash
  - AskUserQuestion
---

## Step 1: Check installation

```bash
which ccsquad 2>/dev/null && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If `NOT_INSTALLED`: tell the user to run `npm install -g ccsquad` and then re-run `/squad`. Stop here.

## Step 2: Check current state

```bash
node -e "
const fs = require('fs');
const p = require('os').homedir() + '/.claude.json';
if (!fs.existsSync(p)) { console.log('MISSING'); process.exit(); }
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log(d.mcpServers && d.mcpServers.ccsquad ? 'CONFIGURED' : 'MISSING');
" 2>/dev/null || echo "MISSING"
```

```bash
grep -q "ccsquad:start" CLAUDE.md 2>/dev/null && echo "HAS_BLOCK" || echo "NO_BLOCK"
```

If already `CONFIGURED` and `HAS_BLOCK`: skip to Step 4 — no need to re-run init.

## Step 3: Run init

Ask the user which coordination mode they want:

> How proactive should ccsquad coordination be?
>
> A) **passive** — read messages on session start, broadcast major decisions
> B) **aggressive** — also broadcast intent before making changes that affect other instances

Then run:

```bash
ccsquad init --mode <chosen-mode>
```

## Step 4: Show squad status

```bash
ccsquad status
```

## Step 5: Tell the user what's next

If no other instances are showing in status:

> Squad is ready. ccsquad is now active for every Claude Code window you open on this machine — no setup needed in other windows. Just open them and they'll register automatically.

If other instances are already showing:

> Squad is live. You can use `list_instances`, `broadcast`, `ask_instance`, `check_inbox`, `answer`, `read_messages`, `set_shared`, and `get_shared` directly — just ask naturally and Claude will call the right tool.
