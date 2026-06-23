# ============================================================================
# Heartmorrow installer (Windows) — self-contained, no prerequisites.
#
# Downloads a pinned, official Node.js into .\.runtime\node (nothing is
# installed system-wide), activates the exact pnpm pinned in package.json via
# corepack, then installs dependencies and seeds the sample database.
#
# Run it once:   powershell -ExecutionPolicy Bypass -File .\install.ps1
# Then play:     .\run.bat
#
# Pass -Yes (or set HEARTMORROW_YES=1) to skip the download confirmation when
# running unattended.
# ============================================================================
param([switch]$Yes)
$ErrorActionPreference = "Stop"

# --- Pinned toolchain -------------------------------------------------------
# Bump this to the current Node 24 LTS. The matching checksum is fetched from
# nodejs.org automatically, so you only ever edit this one line.
$NodeVersion = "24.17.0"

$Root    = $PSScriptRoot
$Rt      = Join-Path $Root ".runtime"
$NodeDir = Join-Path $Rt "node"
$Stamp   = Join-Path $Rt ".installed-node-$NodeVersion"

function Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Info($m) { Write-Host "     $m" -ForegroundColor DarkGray }
function Die($m)  { Write-Host "[X]  $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "===================================================="
Write-Host "  Heartmorrow - self-contained install"
Write-Host "===================================================="
Write-Host ""

# --- 1. Detect arch -> official Node dist name ------------------------------
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$pkg  = "node-v$NodeVersion-win-$arch"
$url  = "https://nodejs.org/dist/v$NodeVersion/$pkg.zip"

# --- 2. Download + verify + extract a vendored Node (idempotent) ------------
if ((Test-Path (Join-Path $NodeDir "node.exe")) -and (Test-Path $Stamp)) {
  Ok "Vendored Node v$NodeVersion already present (.runtime\node)"
} else {
  # --- Tell the user exactly what is about to happen, and let them opt out ---
  Write-Host ""
  Write-Host "Node.js was not found in .runtime\node, so this installer needs to download it."
  Write-Host "  What:  Node.js v$NodeVersion (win-$arch), the official build"
  Write-Host "  From:  $url"
  Write-Host "  Into:  $NodeDir  (local to this folder; nothing is installed system-wide)"
  Info "The download is verified against nodejs.org's official SHA-256 checksums."
  Write-Host ""
  if (-not ($Yes -or $env:HEARTMORROW_YES)) {
    $reply = Read-Host "Download Node.js now? [Y/n]"
    if ($reply -and $reply -notmatch '^(y|yes)$') {
      Die "Aborted at user request. No files were downloaded."
    }
  }

  New-Item -ItemType Directory -Force $Rt | Out-Null
  $zip = Join-Path $env:TEMP "$pkg.zip"

  Write-Host "Downloading Node v$NodeVersion (win-$arch)..."
  try { Invoke-WebRequest $url -OutFile $zip -UseBasicParsing }
  catch { Die "Download failed: $url" }

  # Verify against the official SHASUMS256.txt for this exact version.
  try { $sums = (Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content }
  catch { Die "Could not fetch checksums for Node v$NodeVersion." }
  $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape("$pkg.zip") } | Select-Object -First 1)
  if (-not $line) { Die "No checksum entry for $pkg.zip - is `$NodeVersion valid?" }
  $expected = ($line -split '\s+')[0].ToUpper()
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToUpper()
  if ($got -ne $expected) { Die "Checksum mismatch for $pkg.zip (expected $expected, got $got)." }
  Ok "Download verified ($expected)"

  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  Expand-Archive $zip $Rt -Force
  Rename-Item (Join-Path $Rt $pkg) "node"
  Remove-Item $zip -Force
  New-Item -ItemType File -Force $Stamp | Out-Null
  Ok "Node installed to .runtime\node"
}

# --- 3. Use ONLY the vendored toolchain for the rest of this script ---------
$env:PATH = "$NodeDir;$env:PATH"
$env:COREPACK_HOME = (Join-Path $Rt "corepack")   # keep corepack's cache inside the repo too
$corepack = Join-Path $NodeDir "corepack.cmd"
Ok "Using node $(& "$NodeDir\node.exe" -v) from $NodeDir"

# --- 4. Activate pinned pnpm, install, seed ---------------------------------
Write-Host ""
Write-Host "Activating pnpm (from package.json ""packageManager"")..."
try { & $corepack enable | Out-Null } catch {}
& $corepack prepare --activate            # reads pnpm@<version> pinned in package.json
$pnpm = Join-Path $NodeDir "pnpm.cmd"
Ok "pnpm $(& $pnpm -v)"

Write-Host ""
Write-Host "Installing dependencies (pnpm install)..."
Push-Location $Root
try {
  & $pnpm install; if ($LASTEXITCODE -ne 0) { Die "pnpm install failed." }
  Ok "Dependencies installed"

  Write-Host ""
  Write-Host "Seeding sample data (pnpm seed)..."
  & $pnpm seed; if ($LASTEXITCODE -ne 0) { Die "pnpm seed failed." }
  Ok "Database seeded"
} finally { Pop-Location }

Write-Host ""
Write-Host "===================================================="
Write-Host "  Install complete." -ForegroundColor Green
Write-Host "  Start Heartmorrow with:   .\run.bat"
Write-Host "===================================================="
Info "Optional: copy .env.example to .env to point at your LLM provider."
Write-Host ""
