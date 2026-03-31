---
name: squad
preamble-tier: 4
version: 1.0.0
description: |
  Set up ccsquad for this project — wires up MCP, injects CLAUDE.md coordination block,
  shows squad status. Use when asked to "set up squad", "add ccsquad", "coordinate instances",
  or "/squad". (ccsquad)
allowed-tools:
  - Bash
  - AskUserQuestion
---

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -exec rm {} + 2>/dev/null || true
_CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_PROACTIVE_PROMPTED=$([ -f ~/.gstack/.proactive-prompted ] && echo "yes" || echo "no")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_SKILL_PREFIX=$(~/.claude/skills/gstack/bin/gstack-config get skill_prefix 2>/dev/null || echo "false")
echo "PROACTIVE: $_PROACTIVE"
echo "PROACTIVE_PROMPTED: $_PROACTIVE_PROMPTED"
echo "SKILL_PREFIX: $_SKILL_PREFIX"
source <(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null) || true
REPO_MODE=${REPO_MODE:-unknown}
echo "REPO_MODE: $REPO_MODE"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
_TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: ${_TEL:-off}"
echo "TEL_PROMPTED: $_TEL_PROMPTED"
mkdir -p ~/.gstack/analytics
if [ "${_TEL:-off}" != "off" ]; then
  echo '{"skill":"squad","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do
  if [ -f "$_PF" ]; then
    rm -f "$_PF" 2>/dev/null || true
  fi
  break
done
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
if [ -f "$_LEARN_FILE" ]; then
  _LEARN_COUNT=$(wc -l < "$_LEARN_FILE" 2>/dev/null | tr -d ' ')
  echo "LEARNINGS: $_LEARN_COUNT entries loaded"
else
  echo "LEARNINGS: 0"
fi
_HAS_ROUTING="no"
if [ -f CLAUDE.md ] && grep -q "## Skill routing" CLAUDE.md 2>/dev/null; then
  _HAS_ROUTING="yes"
fi
_ROUTING_DECLINED=$(~/.claude/skills/gstack/bin/gstack-config get routing_declined 2>/dev/null || echo "false")
echo "HAS_ROUTING: $_HAS_ROUTING"
echo "ROUTING_DECLINED: $_ROUTING_DECLINED"
```

Handle UPGRADE_AVAILABLE, JUST_UPGRADED, LAKE_INTRO, TEL_PROMPTED, PROACTIVE_PROMPTED, and HAS_ROUTING the same way all gstack skills do (see any other SKILL.md for the standard handling blocks).

## Step 1: Check installation

```bash
which ccsquad 2>/dev/null && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If `NOT_INSTALLED`: tell the user to run `npm install -g ccsquad` first, then re-run `/squad`. Stop here.

## Step 2: Check current state

```bash
python3 -c "
import sys, json, os
p = os.path.expanduser('~/.claude.json')
if not os.path.exists(p):
    print('MISSING')
    sys.exit()
d = json.load(open(p))
print('CONFIGURED' if 'ccsquad' in d.get('mcpServers', {}) else 'MISSING')
" 2>/dev/null || echo "MISSING"
```

Also check if a ccsquad block already exists in CLAUDE.md:

```bash
grep -q "ccsquad:start" CLAUDE.md 2>/dev/null && echo "HAS_BLOCK" || echo "NO_BLOCK"
```

## Step 3: Choose mode and run init

If MCP is `MISSING` or CLAUDE.md has `NO_BLOCK`, ask the user which coordination mode they want:

> You're setting up ccsquad on **[repo name]** (`_BRANCH` branch). This wires up a shared channel so multiple Claude Code instances working on the same repo can broadcast decisions, ask questions, and stay in sync.
>
> How proactive should coordination be?

RECOMMENDATION: Choose passive — it's the right default. Aggressive is better once you're running 3+ instances simultaneously on fast-moving parallel work.

- A) **passive** — read messages on session start, broadcast major decisions (schema changes, API contracts, shared utilities). Completeness: 9/10
- B) **aggressive** — also broadcast *intent* before making changes that could affect other instances. Completeness: 9/10

Then run:

```bash
ccsquad init --mode <chosen-mode>
```

If already `CONFIGURED` and `HAS_BLOCK`, run with `--update` to refresh:

```bash
ccsquad init --mode <chosen-mode> --update
```

## Step 4: Show squad status

```bash
ccsquad status
```

## Step 5: Tell the user what's next

If no other instances are showing in status:

> Squad is ready on this instance. Open Claude Code in your other project worktree and run `/squad` there too. The second instance will get a standup notice on its first tool call showing who's already active.

If other instances are already showing:

> Squad is live. All instances have `broadcast`, `read_messages`, `ask`, `answer`, `list_instances`, `set_shared`, and `get_shared`. The CLAUDE.md block tells each CC when to use them automatically.

## Telemetry (run last)

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
if [ "$_TEL" != "off" ]; then
  echo '{"skill":"squad","duration_s":"'"$_TEL_DUR"'","outcome":"OUTCOME","browse":"false","session":"'"$_SESSION_ID"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
  if [ -x ~/.claude/skills/gstack/bin/gstack-telemetry-log ]; then
    ~/.claude/skills/gstack/bin/gstack-telemetry-log \
      --skill "squad" --duration "$_TEL_DUR" --outcome "OUTCOME" \
      --used-browse "false" --session-id "$_SESSION_ID" 2>/dev/null &
  fi
fi
```

Replace `OUTCOME` with `success`, `error`, or `abort` based on how the workflow ended.
