#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# OpenRemote Claude Code Bridge — uninstall for macOS / Linux
#
# Usage: bash uninstall.sh
#
# This script ONLY removes items added by setup.sh:
#   1. PATH wrapper at ~/.local/bin/clauderemote
#   2. PATH export lines marked with "# Added by Claude Code PTY Bridge"
#   3. OpenRemote hooks from ~/.claude/settings.json
#
# It will NOT touch any other user configuration.
# ─────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/hooks/forward.cjs"

echo "=== OpenRemote Claude Code Bridge Uninstall ==="
echo ""

# ── Step 1: Remove PATH wrapper ───────────────────────────────

WRAPPER="$HOME/.local/bin/clauderemote"

if [ -f "$WRAPPER" ]; then
  rm "$WRAPPER"
  echo "[1/3] Removed: $WRAPPER"
else
  echo "[1/3] Wrapper not found (already removed): $WRAPPER"
fi

# ── Step 2: Remove PATH export from shell rc files ────────────

echo "[2/3] Cleaning PATH entries from shell config files..."

# The marker added by setup.sh — only remove lines with this exact marker
MARKER="# Added by Claude Code PTY Bridge"

cleanRc() {
  local rc_file="$1"
  if [ ! -f "$rc_file" ]; then
    return
  fi

  if ! grep -qF "$MARKER" "$rc_file" 2>/dev/null; then
    echo "  $rc_file — no entries found"
    return
  fi

  # Remove the marker line and the export line immediately after it
  # Pattern: marker comment line, followed by optional blank line, then the export line
  sed -i.bak -e "/^${MARKER}$/d" -e '/^export PATH="\$HOME\/\.local\/bin:\$PATH"$/d' "$rc_file"
  rm -f "${rc_file}.bak"
  echo "  $rc_file — cleaned"
}

cleanRc "$HOME/.zshrc"
cleanRc "$HOME/.bashrc"
cleanRc "$HOME/.bash_profile"
cleanRc "$HOME/.profile"

# ── Step 3: Remove hooks from Claude Code settings ────────────

echo "[3/3] Removing OpenRemote hooks from Claude Code settings..."
CLAUDE_DIR="$HOME/.claude"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"

if [ ! -f "$CLAUDE_SETTINGS" ]; then
  echo "  settings.json not found — nothing to remove"
else
  # Backup before modifying
  cp "$CLAUDE_SETTINGS" "$CLAUDE_SETTINGS.bak"
  echo "  Backup: $CLAUDE_SETTINGS.bak"

  HOOK_CMD="node \"$HOOK\""

  node -e '
  const fs = require("fs");
  const settingsFile = process.argv[1];
  const hookCmd = process.argv[2];

  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { process.exit(0); }
  if (!settings.hooks) { process.exit(0); }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(
      entry => !(entry.hooks && entry.hooks.some(h => h.command === hookCmd))
    );
    removed += before - settings.hooks[event].length;

    // Remove empty arrays to keep settings clean
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  if (removed > 0) {
    // Remove empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    console.log("  Removed " + removed + " hook(s) from " + settingsFile);
  } else {
    console.log("  No OpenRemote hooks found in settings");
  }
  ' "$CLAUDE_SETTINGS" "$HOOK_CMD"
fi

# ── Done ──────────────────────────────────────────────────────

echo ""
echo "=== Uninstall complete! ==="
echo ""
echo "  The following were NOT removed (to preserve your project):"
echo "    - node_modules/"
echo "    - dist/"
echo ""
echo "  To remove them manually:"
echo "    rm -rf $SCRIPT_DIR/node_modules $SCRIPT_DIR/dist"
echo ""
