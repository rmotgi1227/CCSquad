# claude-squad

A shared communication channel for Claude Code instances. A Slack channel for your agents.

You run 3-4 Claude Code instances simultaneously, each on a different branch building a different feature. They're completely isolated — each only knows what's in its own context window. This causes drift: one uses Prisma, another raw SQL. One throws `AppError`, another returns `{ error: string }`. Duplicate utilities. Incompatible schemas. No way to share a decision across features.

claude-squad fixes this. Drop something important, others catch up. Ask a question, get an answer. That's it.

```
Instance A (feature/auth)      → "switching to tRPC for all API routes"
Instance B (feature/payments)  → reads it, stays aligned
Instance C (feature/ui)        → "what error class are we using?" → A answers: "AppError"
```

---

## How it works

```
CC Instance A → stdio MCP → bridge process A ──┐
CC Instance B → stdio MCP → bridge process B ──┼──► shared daemon → SQLite (~/.claude-squad/)
CC Instance C → stdio MCP → bridge process C ──┘
```

One daemon runs per machine. All Claude Code instances connect to it via a shared Unix socket. Messages persist in SQLite. Instances register on first tool call and drop off after 30 minutes of inactivity.

---

## Install

```bash
npm install -g claude-squad
```

Then register it as a global MCP server:

```bash
claude mcp add --scope user claude-squad claude-squad
```

That's it. The daemon starts automatically on first use.

---

## Setup: git worktrees (recommended)

You can't have two branches checked out in the same directory. Use git worktrees — same repo, separate directories, each on its own branch:

```bash
# From your project root
git worktree add ../my-project-auth feature/auth
git worktree add ../my-project-payments feature/payments
```

Then open Claude Code in each:

```bash
# Terminal 1
cd ../my-project-auth && claude

# Terminal 2
cd ../my-project-payments && claude
```

Each instance auto-registers with its branch name. `list_instances` in either window sees the full squad.

---

## Name your instances (optional)

By default instances are named after their directory. Set a custom name:

```bash
export CLAUDE_SQUAD_NAME="Frontend"
claude
```

Messages will show `Frontend says:` instead of `my-project-auth says:`.

---

## Tools

All tools are available to Claude automatically — just ask naturally.

### `broadcast(message, tags?)`
Share context with the whole squad. Use this for decisions, conventions, or anything others should know.

```
"Tell the other instances we're using soft deletes on the users table"
→ broadcast("users table uses soft deletes — deleted_at column, no hard deletes", ["db-schema"])
```

### `read_messages(since?, tags?, limit?)`
Catch up on what other instances shared. Default: last 5 messages. Max: 20.

```
"What have the other instances been working on?"
→ read_messages(limit: 5)
```

### `ask(question, context?)`
Post a question to the squad. Returns a question ID others can answer.

```
"Ask the other instances what error handling pattern they're using"
→ ask("What error class are we using? AppError, HttpError, or custom?")
→ Question posted (id: 4)
```

### `answer(question_id, answer)`
Respond to a question from another instance.

```
"Answer question 4 — we're using AppError with a statusCode field"
→ answer(question_id: 4, answer: "AppError class with statusCode: number field")
```

### `list_instances()`
See who's active — name, branch, directory, last seen.

```
"Who else is working on this repo?"
→ • Frontend@feature/auth — my-project-auth (2m ago)
   • Backend@feature/payments — my-project-payments (5m ago)
```

### `set_shared(key, value)`
Pin a structured fact in the shared KV store. Max 50KB per value. Use this for things every instance should know: DB schema, error conventions, shared utilities.

```
"Pin our DB schema so other instances can reference it"
→ set_shared("db_schema", "users(id, email, deleted_at), posts(id, user_id, body, created_at)")
```

### `get_shared(key)`
Retrieve a pinned fact by key.

```
"What DB schema did we agree on?"
→ get_shared("db_schema")
```

---

## Example workflow

Tell Claude at the start of a session:

> You're building the payments feature. Before you start, check what the other instances have shared. Broadcast any major architectural decisions you make during this session.

It'll call `read_messages` on startup and `broadcast` when it makes calls that affect other features. No manual coordination needed.

---

## CLI commands

```bash
# Check squad status (works without Claude)
claude-squad status

# Export channel history as markdown (paste into any session)
claude-squad export > context.md
```

---

## Data

Everything is stored locally on your machine:

```
~/.claude-squad/
  state.db      ← SQLite database (messages, instances, KV)
  server.sock   ← Unix socket (daemon IPC)
```

Messages are pruned after 7 days. No data leaves your machine.

---

## Requirements

- Node.js 18+
- Claude Code 1.x
- macOS / Linux (Windows: TCP fallback on 127.0.0.1:38475)

---

## Contributing

Issues and PRs welcome. See [TODOS.md](TODOS.md) for the roadmap.

Planned: web dashboard, intention claims (`propose_change`), Cursor/Copilot adapters.
