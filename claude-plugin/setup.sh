#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# OpenRemote Claude Code Bridge — setup for macOS / Linux
#
# Usage: bash setup.sh
#
# This script:
#   1. Checks build prerequisites (node, npm, C compiler)
#   2. Installs npm dependencies
#   3. Builds TypeScript
#   4. Creates PATH wrapper at ~/.local/bin/clauderemote
#   5. Ensures ~/.local/bin is in PATH
#   6. Configures Claude Code hooks in ~/.claude/settings.json
#
# After setup, use `clauderemote` for remote-controlled sessions.
# The original `claude` command remains unchanged.
# ─────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$SCRIPT_DIR/dist/index.js"
HOOK="$SCRIPT_DIR/hooks/forward.cjs"

echo "=== OpenRemote Claude Code Bridge Setup ==="
echo ""

# ── Prerequisites ─────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "ERROR: node is required but not found" >&2
  echo "  Install: https://nodejs.org" >&2
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "ERROR: npm is required but not found" >&2
  exit 1
fi

echo "Node: $(node --version)  npm: $(npm --version)"

# node-pty requires native compilation — check for build tools
if ! command -v cc &>/dev/null && ! command -v gcc &>/dev/null && ! command -v clang &>/dev/null; then
  echo ""
  echo "WARNING: No C compiler found (gcc/clang)." >&2
  echo "  node-pty requires native build tools." >&2
  echo "  macOS: xcode-select --install" >&2
  echo "  Debian/Ubuntu: sudo apt install build-essential" >&2
  echo "  Fedora: sudo dnf groupinstall 'Development Tools'" >&2
  echo ""
  echo "Continuing anyway — npm install may fail..."
fi

# ── Step 1: Install dependencies ─────────────────────────────

echo ""
echo "[1/5] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install

# node-pty prebuilds may lack execute permission on spawn-helper
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

# ── Step 2: Build ─────────────────────────────────────────────

echo "[2/5] Building TypeScript..."
npm run build

if [ ! -f "$BRIDGE" ]; then
  echo "ERROR: Build failed — dist/index.js not found" >&2
  exit 1
fi

# ── Step 3: Create PATH wrapper ───────────────────────────────

echo "[3/5] Installing PATH wrapper..."
mkdir -p ~/.local/bin

WRAPPER="$HOME/.local/bin/clauderemote"

# Resolve absolute path to node (handles nvm/fnm/volta)
NODE_BIN="$(command -v node)"
BRIDGE_ABS="$(cd "$SCRIPT_DIR" && pwd)/dist/index.js"

cat > "$WRAPPER" << WRAPPER_EOF
#!/usr/bin/env bash
# OpenRemote Claude Code Bridge — dynamically resolves real claude
SELF="\$(readlink -f "\$0" 2>/dev/null || realpath "\$0" 2>/dev/null || echo "\$0")"
REAL_CLAUDE=""
while IFS= read -r candidate; do
  resolved="\$(readlink -f "\$candidate" 2>/dev/null || realpath "\$candidate" 2>/dev/null || echo "\$candidate")"
  if [ "\$resolved" != "\$SELF" ]; then
    REAL_CLAUDE="\$candidate"
    break
  fi
done < <(which -a claude 2>/dev/null)

if [ -z "\$REAL_CLAUDE" ]; then
  echo "[ClaudeRemote] ERROR: cannot find real 'claude' binary" >&2
  echo "  Install: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

exec "$NODE_BIN" "$BRIDGE_ABS" "\$REAL_CLAUDE" "\$@"
WRAPPER_EOF

chmod +x "$WRAPPER"
echo "  Created: $WRAPPER"

# ── Step 4: Ensure PATH ───────────────────────────────────────

echo "[4/5] Configuring PATH..."

addToRc() {
  local rc_file="$1"
  if ! grep -q '.local/bin' "$rc_file" 2>/dev/null; then
    echo '' >> "$rc_file"
    echo '# Added by Claude Code PTY Bridge' >> "$rc_file"
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc_file"
    echo "  Added ~/.local/bin to PATH in $rc_file"
    return 0
  fi
  echo "  ~/.local/bin already in $rc_file"
  return 1
}

path_updated=false

if [ -n "${ZSH_VERSION:-}" ] || [ "${SHELL##*/}" = "zsh" ]; then
  addToRc "$HOME/.zshrc" && path_updated=true
elif [ -n "${BASH_VERSION:-}" ]; then
  addToRc "$HOME/.bashrc" && path_updated=true
  # macOS login shells read .bash_profile instead of .bashrc
  if [ "$(uname)" = "Darwin" ]; then
    addToRc "$HOME/.bash_profile" && path_updated=true
  fi
else
  addToRc "$HOME/.profile" && path_updated=true
fi

if [ "$path_updated" = true ]; then
  echo "  Run 'source ~/.bashrc' (or open a new terminal) to reload PATH"
fi

# ── Step 5: Configure Claude Code hooks ───────────────────────

echo "[5/5] Configuring Claude Code hooks..."
CLAUDE_DIR="$HOME/.claude"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"

mkdir -p "$CLAUDE_DIR"

# Read existing settings or start fresh
SETTINGS="{}"
if [ -f "$CLAUDE_SETTINGS" ]; then
  SETTINGS="$(cat "$CLAUDE_SETTINGS")"
fi

# Use node to merge hook config into settings (portable, no jq dependency)
HOOK_CMD="node \"$HOOK\""
node -e '
const fs = require("fs");
const settingsFile = process.argv[1];
const hookCmd = process.argv[2];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch {}
if (!settings.hooks) settings.hooks = {};

const hookEntry = {
  matcher: "",
  hooks: [{ type: "command", command: hookCmd }]
};

const events = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "PostToolUse", "PreToolUse"];
for (const event of events) {
  if (!settings.hooks[event]) {
    settings.hooks[event] = [hookEntry];
  } else {
    const exists = settings.hooks[event].some(
      entry => entry.hooks && entry.hooks.some(h => h.command === hookCmd)
    );
    if (!exists) {
      settings.hooks[event].push(hookEntry);
    }
  }
}

fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
console.log("  Hooks configured in " + settingsFile);
' "$CLAUDE_SETTINGS" "$HOOK_CMD"

# ── Done ──────────────────────────────────────────────────────

echo ""
echo "=== Setup complete! ==="
echo ""
echo "  Wrapper:  $WRAPPER"
echo "  Bridge:   $BRIDGE_ABS"
echo "  Hooks:    $CLAUDE_SETTINGS"
echo ""
echo "Usage:"
echo "  1. Open a new terminal (to reload PATH)"
echo "  2. Run 'clauderemote' — starts Claude Code with remote bridge"
echo "  3. Run 'claude' — normal unbridged session (unchanged)"
echo ""
echo "Make sure you have configured your token:"
echo "  export OPENREMOTE_TOKEN=ort_xxxxx"
echo "  OR"
echo "  echo '{\"token\":\"ort_xxxxx\"}' > ~/.openremote/credentials.json"
echo ""
echo "To uninstall:"
echo "  rm $WRAPPER"
echo "  Remove hooks from $CLAUDE_SETTINGS"
