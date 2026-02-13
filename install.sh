#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# install.sh — Install orchestrator command + memory search system
#
# What this does:
#   1. Checks for Node.js >= 18
#   2. Installs memory-search npm dependencies + builds TypeScript
#   3. Creates ~/.cursor/memory/ directory structure
#   4. Copies orchestrator command and memory-agent to Cursor locations
#   5. Symlinks memory-search CLI to ~/.local/bin/
#   6. Builds the initial search index (triggers GGUF model download ~0.6GB)
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEMORY_SEARCH_DIR="$SCRIPT_DIR/memory-search"

CURSOR_COMMANDS_DIR="$HOME/.cursor/commands"
CURSOR_AGENTS_DIR="$HOME/.cursor/agents"
MEMORY_DIR="$HOME/.cursor/memory"
SESSIONS_DIR="$MEMORY_DIR/sessions"
DYNAMIC_AGENTS_DIR="$CURSOR_AGENTS_DIR/dynamic"
LOCAL_BIN="$HOME/.local/bin"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ---- Step 1: Check Node.js ------------------------------------------------

info "Checking Node.js version..."

if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Please install Node.js >= 18."
  error "  https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js >= 18 required. Found: $(node -v)"
  exit 1
fi

info "Node.js $(node -v) — OK"

# ---- Step 2: Install memory-search dependencies + build -------------------

info "Installing memory-search dependencies..."
cd "$MEMORY_SEARCH_DIR"

npm install

info "Building TypeScript..."
npm run build

# ---- Step 3: Create directory structure ------------------------------------

info "Creating directory structure..."

mkdir -p "$CURSOR_COMMANDS_DIR"
mkdir -p "$CURSOR_AGENTS_DIR"
mkdir -p "$DYNAMIC_AGENTS_DIR"
mkdir -p "$MEMORY_DIR"
mkdir -p "$SESSIONS_DIR"
mkdir -p "$LOCAL_BIN"

# ---- Step 4: Copy command and agent files ----------------------------------

info "Installing orchestrator command..."
cp "$SCRIPT_DIR/commands/orchestrator.md" "$CURSOR_COMMANDS_DIR/orchestrator.md"

info "Installing memory-agent..."
cp "$SCRIPT_DIR/agents/memory-agent.md" "$CURSOR_AGENTS_DIR/memory-agent.md"

info "Installing memory-recall-agent..."
cp "$SCRIPT_DIR/agents/memory-recall-agent.md" "$CURSOR_AGENTS_DIR/memory-recall-agent.md"

# ---- Step 5: Symlink memory-search to PATH --------------------------------

info "Linking memory-search to $LOCAL_BIN..."

MEMORY_SEARCH_BIN="$MEMORY_SEARCH_DIR/bin/memory-search.js"
LINK_TARGET="$LOCAL_BIN/memory-search"

if [ -L "$LINK_TARGET" ] || [ -e "$LINK_TARGET" ]; then
  rm -f "$LINK_TARGET"
fi
ln -s "$MEMORY_SEARCH_BIN" "$LINK_TARGET"

# Check if ~/.local/bin is in PATH
if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
  warn "$LOCAL_BIN is not in your PATH."
  warn "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
  warn '  export PATH="$HOME/.local/bin:$PATH"'
  echo ""
fi

# ---- Step 6: Create initial MEMORY.md if it doesn't exist -----------------

if [ ! -f "$MEMORY_DIR/MEMORY.md" ]; then
  info "Creating initial MEMORY.md..."
  cat > "$MEMORY_DIR/MEMORY.md" << 'MEMEOF'
# Orchestrator Memory

## User Preferences

## Sub-Agent Patterns

## Decisions Log

## Lessons Learned

## Anti-Patterns
MEMEOF
fi

# ---- Step 7: Build initial search index -----------------------------------

info ""
info "Building initial search index..."
info "(This will download the embedding model on first run — ~0.6GB)"
info ""

node "$MEMORY_SEARCH_BIN" index --verbose || {
  warn "Initial indexing failed. This is OK if the model hasn't downloaded yet."
  warn "Run 'memory-search index' manually after the model downloads."
}

# ---- Done ------------------------------------------------------------------

echo ""
info "========================================="
info " Installation complete!"
info "========================================="
echo ""
info "Installed files:"
info "  Command:  $CURSOR_COMMANDS_DIR/orchestrator.md"
info "  Agents:   $CURSOR_AGENTS_DIR/memory-agent.md"
info "            $CURSOR_AGENTS_DIR/memory-recall-agent.md"
info "  Memory:   $MEMORY_DIR/"
info "  CLI:      $LINK_TARGET -> $MEMORY_SEARCH_BIN"
echo ""
info "Usage:"
info "  memory-search index          Re-index memory files"
info "  memory-search query \"text\"   Search your memories"
info "  memory-search status         Show index statistics"
echo ""
info "The orchestrator slash command is now available in Cursor."
info "Type /orchestrator in any Cursor chat to use it."
echo ""
