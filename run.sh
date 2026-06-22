#!/usr/bin/env bash
# ============================================================================
# Heartmorrow launcher (Linux/macOS) — runs preflight checks, then `pnpm dev`.
# Reports what's wrong and how to fix it before trying to start the app.
# ============================================================================
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBLEMS=0

# Prefer the self-contained toolchain from install.sh, if present, over any
# system Node/pnpm — so a vendored install "just runs".
if [ -x "$ROOT/.runtime/node/bin/node" ]; then
  export PATH="$ROOT/.runtime/node/bin:$PATH"
  export COREPACK_HOME="$ROOT/.runtime/corepack"
fi

# Colors (disabled if not a TTY).
if [ -t 1 ]; then
  RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  RED=''; YEL=''; GRN=''; DIM=''; RST=''
fi
ok()   { echo "${GRN}[OK]${RST} $*"; }
warn() { echo "${YEL}[!]${RST}  $*"; }
err()  { echo "${RED}[X]${RST}  $*"; PROBLEMS=$((PROBLEMS+1)); }
hint() { echo "     ${DIM}$*${RST}"; }

echo
echo "===================================================="
echo "  Heartmorrow - environment preflight"
echo "===================================================="
echo

# --- Node.js ----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed or not on PATH."
  hint "Fix: install Node 20+ from https://nodejs.org/ (or via nvm/brew), then reopen this terminal."
else
  NODE_VER="$(node -v)"                 # e.g. v20.11.0
  NODE_MAJOR="${NODE_VER#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
    err "Node.js $NODE_VER is too old (need >=20)."
    hint "Fix: install Node 20+ (nvm install 20, or 'brew install node')."
  else
    ok "Node.js $NODE_VER"
  fi
fi

# --- pnpm -------------------------------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  err "pnpm is not installed or not on PATH."
  hint "Fix: 'corepack enable' (Node 20+), or 'npm i -g pnpm'."
else
  ok "pnpm $(pnpm -v)"
fi

# --- Dependencies installed -------------------------------------------------
if [ ! -d "$ROOT/node_modules" ]; then
  err "Dependencies are not installed (no node_modules)."
  hint "Fix: pnpm install"
else
  ok "node_modules present"
fi

# --- Workspace esbuild build approval --------------------------------------
if ! grep -q "esbuild: true" "$ROOT/pnpm-workspace.yaml" 2>/dev/null; then
  warn "pnpm-workspace.yaml is missing 'allowBuilds: esbuild: true'."
  hint "Without it esbuild's postinstall is blocked and tsx/vite may not run."
else
  ok "esbuild build approved in pnpm-workspace.yaml"
fi

# --- .env (optional) --------------------------------------------------------
if [ ! -f "$ROOT/.env" ]; then
  warn "No .env file (optional). Defaults will be used."
  hint "LLM features need a provider - copy .env.example to .env and set LLM_BASE_URL/LLM_MODEL."
  hint "Example local provider: LM Studio / Ollama at http://localhost:1234/v1"
else
  ok ".env present"
fi

# --- Port availability (8787 server, 5173 web) ------------------------------
port_in_use() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":$p "
  elif command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -q "[\.:]$p .*LISTEN"
  else
    return 1   # no tool to check; assume free
  fi
}
check_port() {
  local p="$1" label="$2"
  if port_in_use "$p"; then
    warn "Port $p ($label) is already in use."
    hint "Fix: stop the other process (lsof -i:$p / kill), or free the port."
  else
    ok "Port $p ($label) is free"
  fi
}
check_port 8787 server
check_port 5173 web

echo
if [ "$PROBLEMS" -gt 0 ]; then
  echo "===================================================="
  echo "  $PROBLEMS blocking problem(s) found. Fix the [X] items above, then re-run."
  echo "===================================================="
  echo
  exit 1
fi

echo "===================================================="
echo "  All checks passed. Starting Heartmorrow (pnpm dev)..."
echo "  Server: http://localhost:8787    Web: http://localhost:5173"
echo "===================================================="
echo

exec pnpm dev
