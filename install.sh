#!/usr/bin/env bash
# ============================================================================
# Heartmorrow installer (Linux/macOS) — self-contained, no prerequisites.
#
# Downloads a pinned, official Node.js into ./.runtime/node (nothing is
# installed system-wide), activates the exact pnpm pinned in package.json via
# corepack, then installs dependencies and seeds the sample database.
#
# Run it once:   ./install.sh
# Then play:     ./run.sh
#
# Pass -y/--yes (or set HEARTMORROW_YES=1) to skip the download confirmation
# when running unattended.
# ============================================================================
set -euo pipefail

ASSUME_YES="${HEARTMORROW_YES:-}"
case "${1:-}" in -y|--yes) ASSUME_YES=1 ;; esac

# --- Pinned toolchain -------------------------------------------------------
# Bump this to the current Node 24 LTS. The matching checksum is fetched from
# nodejs.org automatically, so you only ever edit this one line.
NODE_VERSION="24.17.0"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RT="$ROOT/.runtime"
NODE_DIR="$RT/node"
STAMP="$RT/.installed-node-$NODE_VERSION"

# Colors (disabled if not a TTY).
if [ -t 1 ]; then
  RED=$'\033[31m'; GRN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  RED=''; GRN=''; DIM=''; RST=''
fi
ok()   { echo "${GRN}[OK]${RST} $*"; }
info() { echo "     ${DIM}$*${RST}"; }
die()  { echo "${RED}[X]${RST}  $*" >&2; exit 1; }

echo
echo "===================================================="
echo "  Heartmorrow - self-contained install"
echo "===================================================="
echo

# --- 1. Detect platform + arch -> official Node dist name -------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) plat=darwin ;;
  Linux)  plat=linux ;;
  *) die "Unsupported OS: $os (this script handles Linux/macOS; use install.ps1 on Windows)." ;;
esac
case "$arch" in
  x86_64|amd64)  a=x64 ;;
  arm64|aarch64) a=arm64 ;;
  *) die "Unsupported CPU architecture: $arch" ;;
esac
pkg="node-v$NODE_VERSION-$plat-$a"
url="https://nodejs.org/dist/v$NODE_VERSION/$pkg.tar.gz"

# sha256 verifier differs across platforms.
verify_sha() {  # $1 = file, $2 = expected hex
  local got
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$1" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$1" | awk '{print $1}')"
  else
    die "Need 'sha256sum' or 'shasum' to verify the download."
  fi
  [ "$got" = "$2" ] || die "Checksum mismatch for $pkg.tar.gz (expected $2, got $got)."
}

# --- 2. Download + verify + extract a vendored Node (idempotent) ------------
if [ -x "$NODE_DIR/bin/node" ] && [ -f "$STAMP" ]; then
  ok "Vendored Node v$NODE_VERSION already present (.runtime/node)"
else
  command -v curl >/dev/null 2>&1 || die "curl is required to download Node."

  # --- Tell the user exactly what is about to happen, and let them opt out ---
  echo
  echo "Node.js was not found in .runtime/node, so this installer needs to download it."
  echo "  What:  Node.js v$NODE_VERSION ($plat-$a), the official build"
  echo "  From:  $url"
  echo "  Into:  $NODE_DIR  (local to this folder; nothing is installed system-wide)"
  info "The download is verified against nodejs.org's official SHA-256 checksums."
  echo
  if [ -z "$ASSUME_YES" ]; then
    if [ -t 0 ]; then
      printf "Download Node.js now? [Y/n] "
      read -r reply
      case "$reply" in ""|y|Y|yes|YES) ;; *) die "Aborted at user request. No files were downloaded." ;; esac
    else
      die "Node.js download needs confirmation but no terminal is attached. Re-run with -y (or HEARTMORROW_YES=1) to proceed."
    fi
  fi

  mkdir -p "$RT"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading Node v$NODE_VERSION ($plat-$a)..."
  curl -fSL "$url" -o "$tmp/node.tar.gz" || die "Download failed: $url"
  curl -fSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/sums" \
    || die "Could not fetch checksums for Node v$NODE_VERSION."

  expected="$(grep "  $pkg.tar.gz\$" "$tmp/sums" | awk '{print $1}')"
  [ -n "$expected" ] || die "No checksum entry for $pkg.tar.gz — is NODE_VERSION valid?"
  verify_sha "$tmp/node.tar.gz" "$expected"
  ok "Download verified ($expected)"

  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/node.tar.gz" -C "$NODE_DIR" --strip-components=1
  touch "$STAMP"
  ok "Node installed to .runtime/node"
fi

# --- 3. Use ONLY the vendored toolchain for the rest of this script ---------
export PATH="$NODE_DIR/bin:$PATH"
export COREPACK_HOME="$RT/corepack"   # keep corepack's cache inside the repo too
ok "Using node $(node -v) from $(command -v node)"

# --- 4. Activate pinned pnpm, install, seed ---------------------------------
echo
echo "Activating pnpm (from package.json \"packageManager\")..."
corepack enable >/dev/null 2>&1 || true
corepack prepare --activate          # reads pnpm@<version> pinned in package.json
ok "pnpm $(pnpm -v)"

echo
echo "Installing dependencies (pnpm install)..."
( cd "$ROOT" && pnpm install )
ok "Dependencies installed"

echo
echo "Seeding sample data (pnpm seed)..."
( cd "$ROOT" && pnpm seed )
ok "Database seeded"

echo
echo "===================================================="
echo "  ${GRN}Install complete.${RST}"
echo "  Start Heartmorrow with:   ./run.sh"
echo "===================================================="
info "Optional: copy .env.example to .env to point at your LLM provider."
echo
