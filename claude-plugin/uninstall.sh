#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# OpenRemote Claude Code Bridge — uninstall for macOS / Linux
#
# Usage: bash uninstall.sh
#
# Reverts everything setup.sh did:
#   1. Remove ~/.local/bin/clauderemote wrapper
#   2. Remove PATH entry from shell rc files
#   3. Remove Claude Code hooks from ~/.claude/settings.json
# ─────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/hooks/forward.cjs"

echo "=== OpenRemote Claude Code Bridge Uninstall ==="
echo ""

# ── Step 1: Remove wrapper ────────────────────────────────────

WRAPPER="$HOME/.local/bin/clauderemote"

if [ -f "$WRAPPER" ]; then
  rm "$WRAPPER"
  echo "[1/3] Removed wrapper: $WRAPPER"
else
  echo "[1/3] Wrapper not found (already removed): $WRAPPER"
fi

# ── Step 2: Remove PATH entry from shell rc files ─────────────

echo "[2/3] Cleaning PATH configuration..."

removeFromRc() {
  local rc_file="$1"
  if [ ! -f "$rc_file" ]; then return 1; fi

  # Check if we added anything
  if ! grep -q 'Added by Claude Code PTY Bridge' "$rc_file" 2>/dev/null; then
    return 1
  fi

  # Remove the two lines we added (comment + export), plus any leading blank line
  # Use a temp file to avoid issues with sed -i on different platforms
  local tmp
  tmp="$(mktemp)"
  awk '
    /^# Added by Claude Code PTY Bridge/ { skip=1; next }
    /^export PATH="\$HOME\/\.local\/bin:\$PATH"/ && skip { skip=0; next }
    { skip=0; print }
  ' "$rc_file" > "$tmp"

  # Remove trailing blank lines at end of file
  sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$tmp" > "$rc_file"
  rm -f "$tmp"

  echo "  Cleaned: $rc_file"
  return 0
}

cleaned=false
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  if removeFromRc "$rc"; then
    cleaned=true
  fi
done

if [ "$cleaned" = false ]; then
  echo "  No PATH entries to clean"
fi

# ── Step 3: Remove Claude Code hooks ──────────────────────────

echo "[3/3] Cleaning Claude Code hooks..."
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

if [ -f "$CLAUDE_SETTINGS" ]; then
  # Use node to surgically remove our hooks (preserve other settings)
  node -e '
    const fs = require("fs");
    const settingsFile = process.argv[1];
    const hookPrefix = process.argv[2];

    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    } catch {
      console.log("  Could not parse settings.json, skipping");
      process.exit(0);
    }

    if (!settings.hooks) {
      console.log("  No hooks found in settings.json");
      process.exit(0);
    }

    // Find and remove hooks that point to our forward.cjs
    const OUR_HOOKS = ["UserPromptSubmit", "Stop", "PostToolUse"];
    let removed = 0;

    for (const eventName of OUR_HOOKS) {
      if (!settings.hooks[eventName]) continue;

      settings.hooks[eventName] = settings.hooks[eventName].filter(entry => {
        if (!entry || !entry.hooks) return true;
        // Keep if no hook command matches our forward.cjs
        const hasOurHook = entry.hooks.some(h =>
          h.command && h.command.includes("forward.cjs")
        );
        return !hasOurHook;
      });

      // Remove empty arrays
      if (settings.hooks[eventName].length === 0) {
        delete settings.hooks[eventName];
      }
    }

    // Remove empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    console.log("  Cleaned hooks in " + settingsFile);
  ' "$CLAUDE_SETTINGS" "$HOOK"
else
  echo "  No settings.json found, skipping"
fi

# ── Done ──────────────────────────────────────────────────────

echo ""
echo "=== Uninstall complete ==="
echo ""
echo "The following were NOT removed (may be used by other things):"
echo "  ~/.local/bin/           (directory — may contain other tools)"
echo "  ~/.openremote/          (credentials + logs)"
echo "  ~/.claude/              (Claude Code config)"
echo ""
echo "To remove everything:"
echo "  rm -rf ~/.openremote"
echo ""
echo "Open a new terminal to apply PATH changes."
