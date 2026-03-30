# TODOS — claude-squad

## P2: Intention claims (v2)
**What:** `propose_change(file, intent)` tool. Before editing a file, broadcast what you intend to do. Others see "Backend intends to refactor auth.ts — JWT migration." Auto-approve after 30s silence.
**Why:** Turns the channel from a message board into a code negotiation layer. Strong differentiator.
**Effort:** L (human: ~3 days / CC: ~45 min)
**Start:** Add `type: 'proposal'` to messages table, add `propose_change` + `approve_proposal` tools, wire into PreToolUse hook.

## P2: Web dashboard (v1.5)
**What:** Browser UI served by the claude-squad server. Live swim-lane: all instances, recent messages, active questions.
**Why:** The screenshot that gets GitHub stars. Skipped in favor of TUI for v1.
**Effort:** M (human: ~2 days / CC: ~30 min)
**Start:** Add Express route for `/`, serve single-page HTML with auto-refresh every 2s.

## P3: SSE / WebSocket push (v2)
**What:** Real-time push notifications to connected instances when new messages arrive.
**Why:** Currently pull-based (instances poll on tool call). Push would enable true real-time.
**Start:** Upgrade after polling proves insufficient based on user feedback.

## P2: Message retention / auto-pruning (v1.5)
**What:** Prune messages older than 7 days on daemon startup. Add `PRAGMA auto_vacuum = INCREMENTAL` to keep SQLite file size bounded.
**Why:** Without pruning, `~/.claude-squad/state.db` grows unbounded. At 1000 messages/day, that's 7MB/week — noticeable within a month.
**Start:** Add `DELETE FROM messages WHERE created_at < unixepoch() - 604800` to daemon startup sequence.

## P3: Cursor / Copilot adapters (community)
**What:** Community-maintained adapters so Cursor and GitHub Copilot can connect to claude-squad.
**Why:** Platform play — becomes the universal local agent coordination layer.
**Start:** Document the MCP interface clearly in README so community can build adapters.
