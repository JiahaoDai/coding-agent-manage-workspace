#!/usr/bin/env bash
# Publish the coding-agent-dashboard-v1 tickets to GitHub as issues, in
# dependency order (blockers first), each tagged ready-for-agent.
#
# Requires: gh (authenticated). Run with:  bash publish.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISSUES="$DIR/issues"

# 1. Ensure the triage label exists.
gh label create ready-for-agent \
  --color 0E8A16 \
  --description "Spec is ready for an implementing agent" \
  2>/dev/null || true

# 2. Ticket title + file, in dependency order. "Blocked by" lines in the body
#    reference tickets as "#N — Title"; titles disambiguate regardless of the
#    actual GitHub issue number.
titles=(
  "Walking skeleton: create & list a session (fake agent)"
  "Streaming conversation: text + tool calls + thinking (collapsed)"
  "Interactive permission confirmation"
  "Concurrent sessions"
  "Session list: filter, search, status badges"
  "Soft delete + re-import"
  "Create-time resume of existing native sessions"
  "File-tree directory selection"
  "Claude Code adapter"
  "OpenCode adapter"
  "Pi adapter"
)

files=(
  "01-walking-skeleton.md"
  "02-streaming-conversation.md"
  "03-permission-confirmation.md"
  "04-concurrent-sessions.md"
  "05-session-list-filter-search.md"
  "06-soft-delete-reimport.md"
  "07-create-time-resume.md"
  "08-file-tree-selection.md"
  "09-claude-code-adapter.md"
  "10-opencode-adapter.md"
  "11-pi-adapter.md"
)

for i in "${!titles[@]}"; do
  f="$ISSUES/${files[$i]}"
  # Drop the leading "# NN — Title" line; gh takes the title via --title.
  body="$(tail -n +2 "$f")"
  url="$(gh issue create --title "${titles[$i]}" --body "$body" --label ready-for-agent)"
  echo "Created $url — ${titles[$i]}"
done
