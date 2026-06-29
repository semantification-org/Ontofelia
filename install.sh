#!/usr/bin/env bash
set -uo pipefail

# Prevent corepack from prompting interactively. COREPACK_ENABLE_DOWNLOAD_PROMPT
# is essential: without it `corepack prepare` asks "Do you want to continue?"
# on the TTY and the installer hangs forever.
export COREPACK_ENABLE_AUTO_PIN=0
export COREPACK_ENABLE_STRICT=0
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ═══════════════════════════════════════════════════════════════
# Ontofelia Installer — Premium Terminal UI
# ═══════════════════════════════════════════════════════════════

# ── ANSI codes ──
BOLD='\033[1m'
DIM='\033[2m'
ITALIC='\033[3m'
UNDERLINE='\033[4m'
BLINK='\033[5m'

# Foreground
FG_BLACK='\033[30m'
FG_RED='\033[31m'
FG_GREEN='\033[32m'
FG_YELLOW='\033[33m'
FG_BLUE='\033[34m'
FG_PURPLE='\033[35m'
FG_CYAN='\033[36m'
FG_WHITE='\033[37m'
FG_GRAY='\033[90m'
FG_BPURPLE='\033[95m'  # bright purple

# Background
BG_PURPLE='\033[45m'
BG_BLACK='\033[40m'

NC='\033[0m'

# ── Layout constants ──
W=68  # inner width of the frame

# ── Helper functions ──
repeat_char() { printf "%0.s$1" $(seq 1 "$2"); }

# Print a line padded to frame width
frame_line() {
  local content="$1"
  # Strip ANSI codes to calculate visible length (perl is more reliable)
  local visible
  visible=$(echo -e "$content" | perl -pe 's/\e\[[0-9;]*m//g' 2>/dev/null || echo -e "$content" | sed $'s/\033\[[0-9;]*m//g')
  local vlen=${#visible}
  local pad=$((W - vlen))
  if [ "$pad" -lt 0 ]; then pad=0; fi
  local spaces=""
  [ "$pad" -gt 0 ] && spaces=$(printf "%${pad}s" "")
  echo -e "  ${FG_PURPLE}│${NC} ${content}${spaces} ${FG_PURPLE}│${NC}"
}

frame_top() {
  local label="$1"
  local extra_width="${2:-0}"
  local visible
  visible=$(echo -e "$label" | perl -pe 's/\e\[[0-9;]*m//g' 2>/dev/null || echo -e "$label" | sed $'s/\033\[[0-9;]*m//g')
  local llen=${#visible}
  local rlen=$((W - llen - extra_width))
  local right_border
  right_border=$(repeat_char '─' "$rlen")
  echo -e "  ${FG_PURPLE}┌─${NC}${label}${FG_PURPLE}─${right_border}┐${NC}"
}

frame_bottom() {
  local border
  border=$(repeat_char '─' $W)
  echo -e "  ${FG_PURPLE}└─${border}─┘${NC}"
}

frame_divider() {
  local border
  border=$(repeat_char '─' $W)
  echo -e "  ${FG_PURPLE}├─${border}─┤${NC}"
}

frame_empty() {
  frame_line ""
}

# Progress bar inline — returns string (no newline)
make_bar() {
  local current=$1 total=$2 width=${3:-24}
  local filled=$((current * width / total))
  local empty=$((width - filled))
  local bar=""
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=0; i<empty; i++)); do bar+="░"; done
  local pct=$((current * 100 / total))
  echo -ne "${FG_PURPLE}${bar}${NC} ${pct}%"
}

ok()   { echo -e "  ${FG_GREEN}  ✔${NC}  $1"; }
warn() { echo -e "  ${FG_YELLOW}  ⚠${NC}  $1"; }
fail() { echo -e "  ${FG_RED}  ✘${NC}  $1"; }
info() { echo -e "  ${DIM}    $1${NC}"; }

# Step header — framed with progress
TOTAL_STEPS=8
CURRENT_STEP=0
step() {
  CURRENT_STEP=$((CURRENT_STEP + 1))
  echo ""
  local bar
  bar=$(make_bar $CURRENT_STEP $TOTAL_STEPS 20)

  # Build the step line
  local line_text="─── ${CURRENT_STEP}/${TOTAL_STEPS} $1 "
  local text_len=${#line_text}
  local remaining=$((W - text_len + 2))
  local filler=""
  if [ "$remaining" -gt 0 ]; then
    filler=$(repeat_char '─' "$remaining")
  fi

  echo -e "  ${FG_PURPLE}───${NC} ${FG_WHITE}${BOLD}${CURRENT_STEP}${NC}${FG_GRAY}/${TOTAL_STEPS}${NC} ${FG_CYAN}${BOLD}$1${NC} ${FG_PURPLE}${filler}${NC} ${bar}"
  echo ""
}

# Run privileged commands with sudo only when needed — skip it when already
# root (Docker/CI containers) and fall back to direct execution if sudo isn't
# installed, so the installer works in bare root environments too.
if [ "$(id -u)" -eq 0 ] || ! command -v sudo &> /dev/null; then SUDO=""; else SUDO="sudo"; fi

# ── Detect package manager ──
install_pkg() {
  if command -v apt-get &> /dev/null; then
    $SUDO apt-get install -y "$@" > /dev/null 2>&1
  elif command -v dnf &> /dev/null; then
    $SUDO dnf install -y "$@" > /dev/null 2>&1
  elif command -v pacman &> /dev/null; then
    $SUDO pacman -S --noconfirm "$@" > /dev/null 2>&1
  elif command -v brew &> /dev/null; then
    brew install "$@" > /dev/null 2>&1
  else
    fail "No supported package manager found"
    return 1
  fi
}

# ══════════════════════════════════════════
# HEADER PANEL
# ══════════════════════════════════════════
clear

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Get version
VERSION="0.0.1"
if [ -f "$SCRIPT_DIR/apps/cli/dist/index.js" ]; then
  VERSION=$(cd "$SCRIPT_DIR" && node -e "
    const fs = require('fs');
    const src = fs.readFileSync('apps/cli/src/index.ts','utf8');
    const m = src.match(/\\.version\\(['\"]([^'\"]+)/);
    if(m) console.log(m[1]); else console.log('0.0.1');
  " 2>/dev/null || echo "0.0.1")
fi

echo ""
frame_top " ${FG_BPURPLE}${BOLD}🦉 Ontofelia${NC} ${FG_GRAY}v${VERSION}${NC} " 1
frame_empty
frame_line "        ${FG_PURPLE}▄███████▄${NC}"
frame_line "       ${FG_PURPLE}███████████${NC}"
frame_line "      ${FG_PURPLE}███${NC}${FG_YELLOW}███${NC}${FG_PURPLE}█${NC}${FG_YELLOW}███${NC}${FG_PURPLE}███${NC}"
frame_line "      ${FG_PURPLE}███${NC}${FG_YELLOW}█${NC}${FG_WHITE}◉${NC}${FG_YELLOW}█${NC}${FG_PURPLE}█${NC}${FG_YELLOW}█${NC}${FG_WHITE}◉${NC}${FG_YELLOW}█${NC}${FG_PURPLE}███${NC}      ${FG_WHITE}${BOLD}Welcome to Ontofelia${NC}"
frame_line "      ${FG_PURPLE}██████${NC}${FG_WHITE}${BOLD}V${NC}${FG_PURPLE}██████${NC}"
frame_line "      ${FG_PURPLE}█████████████${NC}      ${DIM}The AI agent with semantic memory${NC}"
frame_line "       ${FG_PURPLE}███████████${NC}"
frame_line "        ${FG_PURPLE}▀███████▀${NC}"
frame_line "         ${FG_YELLOW}▀▄   ▄▀${NC}"
frame_empty
frame_divider
frame_empty
frame_line " ${FG_PURPLE}◆${NC} ${FG_WHITE}Semantic Knowledge Graph${NC}    ${FG_PURPLE}◆${NC} ${FG_WHITE}Web UI & Telegram${NC}      "
frame_line " ${FG_PURPLE}◆${NC} ${FG_WHITE}Multi-LLM with Fallback${NC}     ${FG_PURPLE}◆${NC} ${FG_WHITE}Tool Execution${NC}         "
frame_line " ${FG_PURPLE}◆${NC} ${FG_WHITE}OWL-DL Reasoning${NC}            ${FG_PURPLE}◆${NC} ${FG_WHITE}Persistent Memory${NC}      "
frame_empty
frame_bottom
echo ""

# ── Setup scrolling region to fix the header ──
if [ -t 1 ]; then
  term_lines=$(tput lines 2>/dev/null || echo 24)
  if [ "$term_lines" -gt 30 ]; then
    # Header takes 21 lines. Set scrolling region from line 22 to bottom.
    printf "\033[22;${term_lines}r"
    # Move cursor to the start of the scrolling region
    printf "\033[22;1H"
    # Ensure scrolling region is reset on exit
    trap 'printf "\033[r"' EXIT
  fi
fi

# ══════════════════════════════════════════
# STEP 1: Prerequisites
# ══════════════════════════════════════════
step "Prerequisites"

# Node.js
NEED_NODE=false
if ! command -v node &> /dev/null; then
  NEED_NODE=true
else
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 20 ]; then
    NEED_NODE=true
    warn "Node.js $(node -v) — upgrading to 20+..."
  fi
fi

if [ "$NEED_NODE" = true ]; then
  info "Installing Node.js 20..."
  if command -v apt-get &> /dev/null; then
    # Ensure curl + CA certs (minimal images/containers ship neither, which
    # would break the HTTPS download below).
    $SUDO apt-get update -qq > /dev/null 2>&1
    $SUDO apt-get install -y curl ca-certificates > /dev/null 2>&1
    curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh && $SUDO bash /tmp/nodesource_setup.sh > /dev/null 2>&1
    $SUDO apt-get install -y nodejs > /dev/null 2>&1
  elif command -v dnf &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh && $SUDO bash /tmp/nodesource_setup.sh > /dev/null 2>&1
    $SUDO dnf install -y nodejs > /dev/null 2>&1
  elif command -v pacman &> /dev/null; then
    $SUDO pacman -S --noconfirm nodejs npm > /dev/null 2>&1
  elif command -v brew &> /dev/null; then
    brew install node@20 > /dev/null 2>&1
  else
    fail "Cannot auto-install Node.js"
    info "Install manually: https://nodejs.org"
    exit 1
  fi
fi
ok "Node.js ${BOLD}$(node -v)${NC}"

# Ensure Node.js bin dir is in PATH
NODE_BIN_DIR="$(dirname "$(readlink -f "$(command -v node)")")"
if [[ ":$PATH:" != *":$NODE_BIN_DIR:"* ]]; then
  export PATH="$NODE_BIN_DIR:$PATH"
fi

# pnpm — must be a working pnpm that actually runs on the Node above. In WSL the
# Windows npm global (/mnt/c/.../pnpm) leaks onto PATH and is often too new for
# the Linux Node (recent pnpm requires Node 22+), which then crashes with
# "ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite". So we reject any /mnt/* pnpm and any
# pnpm that fails to run, then install a pinned, Node-compatible pnpm.
PNPM_PIN="pnpm@9.0.0"   # matches packageManager in package.json; supports Node 20+

pnpm_usable() {
  command -v pnpm &> /dev/null && [[ "$(command -v pnpm)" != /mnt/* ]] && pnpm --version &> /dev/null
}

if ! pnpm_usable; then
  info "Installing ${PNPM_PIN}..."

  # Prefer corepack, but install the shim into a user-writable directory so it
  # works without sudo. `corepack enable` without --install-directory targets
  # the Node bin dir (often /usr/bin) and fails with EACCES.
  COREPACK_BIN_DIR="$HOME/.local/bin"
  mkdir -p "$COREPACK_BIN_DIR"
  export PATH="$COREPACK_BIN_DIR:$PATH"

  if command -v corepack &> /dev/null; then
    corepack enable --install-directory "$COREPACK_BIN_DIR" 2>/dev/null || true
    # Pin to a Node-compatible pnpm — pnpm@latest now requires Node 22+.
    # COREPACK_ENABLE_DOWNLOAD_PROMPT=0 (set at the top) keeps this from
    # blocking on an interactive "Do you want to continue?" prompt.
    corepack prepare "$PNPM_PIN" --activate 2>/dev/null || true
  fi
  hash -r 2>/dev/null || true

  # Fallback: install pnpm via npm if corepack did not produce a usable shim.
  if ! pnpm_usable; then
    npm install -g "$PNPM_PIN" 2>/dev/null || $SUDO npm install -g "$PNPM_PIN" 2>/dev/null || true
    hash -r 2>/dev/null || true
  fi
fi

if ! pnpm_usable; then
  fail "Could not install a working pnpm for $(node -v)"
  info "In WSL a Windows pnpm on PATH can be too new for the Linux Node."
  info "Install a Linux pnpm and re-run: npm install -g pnpm@9"
  exit 1
fi
ok "pnpm ${BOLD}$(pnpm -v)${NC}"

# Note: the default triplestore is Oxigraph, an embedded npm dependency —
# no Java and no separate server are required. Java is only needed for the
# optional legacy Fuseki backend, so it is no longer installed here.

# Build tools
NEED_BUILD_TOOLS=false
for tool in make g++ python3; do
  if ! command -v "$tool" &> /dev/null; then
    NEED_BUILD_TOOLS=true
    break
  fi
done

if [ "$NEED_BUILD_TOOLS" = true ]; then
  info "Installing build tools..."
  if command -v apt-get &> /dev/null; then
    $SUDO apt-get install -y build-essential python3 > /dev/null 2>&1
  elif command -v dnf &> /dev/null; then
    $SUDO dnf groupinstall -y "Development Tools" > /dev/null 2>&1 && $SUDO dnf install -y python3 > /dev/null 2>&1
  elif command -v pacman &> /dev/null; then
    $SUDO pacman -S --noconfirm base-devel python > /dev/null 2>&1
  fi
fi
ok "Build tools"

# Rust toolchain — only needed to compile the native @ontofelia/reasoner
# addon. The repo ships a prebuilt reasoner.<triple>.node binary, so Rust is
# only required when that prebuilt binary is missing for this platform.
REASONER_DIR="$SCRIPT_DIR/packages/reasoner"
if ! ls "$REASONER_DIR"/*.node &> /dev/null; then
  if ! command -v cargo &> /dev/null; then
    # rustup may already be installed but not on PATH for this shell.
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  fi
  if ! command -v cargo &> /dev/null; then
    info "Installing Rust toolchain (needed to build the reasoner)..."
    if command -v curl &> /dev/null; then
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path > /dev/null 2>&1
      [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    fi
  fi
  if command -v cargo &> /dev/null; then
    ok "Rust ${BOLD}$(cargo --version | awk '{print $2}')${NC}"
  else
    warn "Rust not available — the reasoner cannot be compiled"
    info "Install it via https://rustup.rs, then re-run: bash install.sh"
  fi
else
  ok "Reasoner ${DIM}(prebuilt native binary present)${NC}"
fi

# ══════════════════════════════════════════
# STEP 2: Dependencies
# ══════════════════════════════════════════
step "Dependencies"

cd "$SCRIPT_DIR"

SQLITE_BINDING=$(find "$SCRIPT_DIR/node_modules" -name "better_sqlite3.node" 2>/dev/null | head -1)
if [ -z "$SQLITE_BINDING" ] && [ -d "$SCRIPT_DIR/node_modules" ]; then
  info "Native modules missing — clean install"
  rm -rf "$SCRIPT_DIR/node_modules"
fi

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  info "First install — downloading & compiling..."
  info "This may take 2-3 minutes"
fi

if ! pnpm install --reporter=silent 2>/dev/null; then
  if ! pnpm install; then
    fail "pnpm install failed"
    info "Try: cd $SCRIPT_DIR && pnpm install"
    exit 1
  fi
fi

ok "All dependencies installed"

# ══════════════════════════════════════════
# STEP 3: Build
# ══════════════════════════════════════════
step "Build"

find "$SCRIPT_DIR" -name ".turbo" -type d -exec rm -rf {} + 2>/dev/null || true
# Drop stale TypeScript incremental state: a leftover *.tsbuildinfo without its
# matching dist makes tsc think a package is "up to date" and emit nothing,
# which then breaks dependents (e.g. tools → sandbox). Safe to always clear.
find "$SCRIPT_DIR" -path "$SCRIPT_DIR/node_modules" -prune -o -name "*.tsbuildinfo" -exec rm -f {} + 2>/dev/null || true

# Build via Turborepo. `turbo run build` resolves the dependency graph
# topologically (turbo.json: build dependsOn ^build), so every package is
# built after the packages it imports. A hand-maintained build order would
# silently break whenever a new cross-package dependency is added — e.g.
# providers importing @ontofelia/testkit before testkit was built.
info "Building all packages (Turborepo resolves order)..."
echo ""

if ! pnpm build; then
  echo ""
  fail "Build failed — see the errors above"
  info "Fix the errors, then re-run: bash install.sh"
  exit 1
fi

ok "All packages built successfully"

# ══════════════════════════════════════════
# STEP 4: Triplestore
# ══════════════════════════════════════════
step "Triplestore"

# The default backend is Oxigraph — an embedded triplestore shipped as the
# `oxigraph` npm package and already installed in Step 2. There is no server
# to download and no Java runtime to provision; the gateway initialises the
# embedded store under ~/.ontofelia/triplestore on first start.
ok "Oxigraph (embedded) ready — no download required"
info "Legacy Fuseki backend: install Java 17+ and select it in 'ontofelia onboard'"

# ══════════════════════════════════════════
# STEP 5: CLI
# ══════════════════════════════════════════
step "CLI Command"

BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/ontofelia" << WRAPPER
#!/usr/bin/env node
import("$SCRIPT_DIR/apps/cli/dist/index.js");
WRAPPER
chmod +x "$BIN_DIR/ontofelia"

SHELL_RC=""
if [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.profile" ]; then
  SHELL_RC="$HOME/.profile"
fi

if [ -n "$SHELL_RC" ]; then
  if ! grep -q "$BIN_DIR" "$SHELL_RC" 2>/dev/null; then
    {
      echo ""
      echo "# Ontofelia CLI"
      echo "export PATH=\"$BIN_DIR:\$PATH\""
    } >> "$SHELL_RC"
  fi
fi

export PATH="$BIN_DIR:$PATH"

if command -v ontofelia &> /dev/null; then
  ok "'ontofelia' command linked → ${DIM}$(ontofelia --version)${NC}"
else
  warn "Could not verify command — restart terminal"
fi

# ══════════════════════════════════════════
# STEP 6: Configuration
# ══════════════════════════════════════════
step "Configuration"

CONFIG_FILE="$HOME/.ontofelia/ontofelia.json5"

if [ ! -f "$CONFIG_FILE" ]; then
  info "No config found — launching setup wizard..."
  echo ""
  if [ -t 0 ]; then
    ontofelia onboard
  else
    # No interactive terminal — the wizard cannot prompt. Generate a working
    # default config with a token so the gateway can still start.
    warn "No interactive terminal detected — creating a default config"
    ontofelia onboard --non-interactive
  fi

  # The wizard may have been cancelled (Ctrl+C) or exited before writing the
  # config. Without it there is no gateway token, so abort with a clear hint
  # instead of falsely reporting success later.
  if [ ! -f "$CONFIG_FILE" ]; then
    fail "Onboarding did not complete — no config at $CONFIG_FILE"
    info "Run it manually, then re-run the installer:"
    info "  ontofelia onboard"
    exit 1
  fi
  ok "Configuration created"
else
  ok "Configuration loaded"
fi

# Show current provider
CURRENT_PROVIDER=$(grep -oP "name:\s*'?\K[^',]+" "$CONFIG_FILE" 2>/dev/null | head -1)
CURRENT_MODEL=$(grep -oP "defaultModel:\s*['\"]?\K[^'\",]+" "$CONFIG_FILE" 2>/dev/null | head -1)
if [ -n "$CURRENT_PROVIDER" ] && [ -n "$CURRENT_MODEL" ]; then
  info "Provider: ${CURRENT_PROVIDER} · Model: ${CURRENT_MODEL}"
fi

# ══════════════════════════════════════════
# STEP 7: Telegram Bot (optional)
# ══════════════════════════════════════════
step "Telegram Bot ${DIM}(optional)${NC}"

# Check if already configured
ALREADY_HAS_TG=false
if [ -f "$HOME/.ontofelia/ontofelia.json5" ] && grep -q "telegram" "$HOME/.ontofelia/ontofelia.json5" 2>/dev/null; then
  ALREADY_HAS_TG=true
fi

if [ "$ALREADY_HAS_TG" = true ]; then
  ok "Telegram already configured"
else
  echo -e "  ${DIM}    Connect Ontofelia to Telegram for mobile chat.${NC}"
  echo ""
  read -p "    Configure now? (y/N) " SETUP_TELEGRAM
  echo ""

  if [[ "$SETUP_TELEGRAM" =~ ^[yYjJ]$ ]]; then
    echo -e "  ${DIM}    How to get a token:${NC}"
    echo -e "  ${DIM}    1. Open Telegram → ${FG_WHITE}@BotFather${NC}"
    echo -e "  ${DIM}    2. Send /newbot → follow instructions${NC}"
    echo -e "  ${DIM}    3. Copy the token${NC}"
    echo ""
    read -p "    Bot Token: " TG_TOKEN

    if [ -n "$TG_TOKEN" ]; then
      CONFIG_FILE="$HOME/.ontofelia/ontofelia.json5"
      if [ -f "$CONFIG_FILE" ]; then
        if grep -q "channels: {}" "$CONFIG_FILE"; then
          sed -i "s|channels: {}|channels: {\n    telegram: {\n      enabled: true,\n      token: '$TG_TOKEN',\n    },\n  }|" "$CONFIG_FILE"
        else
          sed -i "/channels: {/a\\    telegram: {\n      enabled: true,\n      token: '$TG_TOKEN',\n    }," "$CONFIG_FILE"
        fi
        ok "Telegram bot configured"
      fi
    else
      warn "No token — skipped"
    fi
  else
    info "Skipped. Add later in ~/.ontofelia/ontofelia.json5"
  fi
fi

# ══════════════════════════════════════════
# STEP 8: Launch
# ══════════════════════════════════════════
step "Launch"

GATEWAY_OK=true
if ! ontofelia gateway start; then
  GATEWAY_OK=false
fi

# Get actual port and token from config
GW_PORT=$(grep -oP "port:\s*\K[0-9]+" "$CONFIG_FILE" 2>/dev/null | head -1)
GW_PORT=${GW_PORT:-18780}
GW_TOKEN=$(grep -oP "token:\s*['\"]?\K[^'\"',]+" "$CONFIG_FILE" 2>/dev/null | head -1)

sleep 1
echo ""

# ── Final status panel ──
if [ -t 1 ]; then
  printf "\033[r" # Reset scrolling region
fi

if [ "$GATEWAY_OK" != true ]; then
  # Honest failure panel — the install finished but the gateway is not up.
  frame_top " ${FG_YELLOW}${BOLD}⚠ Installed — gateway not running${NC} "
  frame_empty
  frame_line " The build and setup completed, but the gateway failed to start."
  frame_line ""
  frame_line " ${FG_WHITE}Inspect the error:${NC}"
  frame_line "   ${FG_CYAN}cat ~/.ontofelia/logs/gateway.log${NC}"
  frame_line ""
  frame_line " ${FG_WHITE}Then retry:${NC}"
  frame_line "   ${FG_CYAN}ontofelia gateway start${NC}"
  frame_empty
  frame_bottom
  echo ""
  exit 1
fi

# Install lightweight always-on supervision (cron watchdog + @reboot start) —
# the replacement for a container's `--restart unless-stopped` on boxes without
# a user systemd bus. install-daemon.sh is idempotent and leaves the already
# running gateway alone.
if [ -x "$SCRIPT_DIR/scripts/install-daemon.sh" ]; then
  if "$SCRIPT_DIR/scripts/install-daemon.sh" >/dev/null 2>&1; then
    ok "Always-on supervision installed ${DIM}(cron watchdog + @reboot)${NC}"
  else
    warn "Could not install cron supervision — the gateway is up, but auto-restart is off"
  fi
fi

frame_top " ${FG_GREEN}${BOLD}✔ Installation Complete${NC} "
frame_empty
frame_line "        ${FG_PURPLE}▄███████▄${NC}"
frame_line "       ${FG_PURPLE}███████████${NC}"
frame_line "      ${FG_PURPLE}███${NC}${FG_YELLOW}███${NC}${FG_PURPLE}█${NC}${FG_YELLOW}███${NC}${FG_PURPLE}███${NC}"
frame_line "      ${FG_PURPLE}███${NC}${FG_YELLOW}█${NC}${FG_WHITE}◉${NC}${FG_YELLOW}█${NC}${FG_PURPLE}█${NC}${FG_YELLOW}█${NC}${FG_WHITE}◉${NC}${FG_YELLOW}█${NC}${FG_PURPLE}███${NC}      ${FG_WHITE}${BOLD}Ontofelia is running!${NC}"
frame_line "      ${FG_PURPLE}██████${NC}${FG_WHITE}${BOLD}V${NC}${FG_PURPLE}██████${NC}"
frame_line "      ${FG_PURPLE}█████████████${NC}"
frame_line "       ${FG_PURPLE}███████████${NC}"
frame_line "        ${FG_PURPLE}▀███████▀${NC}"
frame_line "         ${FG_YELLOW}▀▄   ▄▀${NC}"
frame_empty
frame_divider
frame_empty
frame_line " ${FG_GREEN}Web UI${NC}     ${FG_WHITE}${UNDERLINE}http://127.0.0.1:${GW_PORT}${NC}                       "
if [ -n "$GW_TOKEN" ]; then
frame_line " ${FG_GREEN}Token${NC}      ${FG_YELLOW}${GW_TOKEN}${NC}"
fi
frame_line " ${FG_GREEN}Status${NC}     ${FG_WHITE}ontofelia status${NC}                            "
frame_line " ${FG_GREEN}Logs${NC}       ${FG_WHITE}ontofelia gateway logs${NC}                      "
frame_line " ${FG_GREEN}Stop${NC}       ${FG_WHITE}ontofelia gateway stop${NC}                      "
frame_empty
frame_bottom
echo ""
echo -e "  $(make_bar $TOTAL_STEPS $TOTAL_STEPS 30)"
echo ""
