@echo off
setlocal enabledelayedexpansion

REM ============================================================================
REM Heartmorrow launcher (Windows) - runs preflight checks, then production.
REM Reports what's wrong and how to fix it before trying to start the app.
REM ============================================================================

set "PROBLEMS=0"
set "ROOT=%~dp0"
if "%APP_URL%"=="" set "APP_URL=http://127.0.0.1:5173"

REM Prefer the self-contained toolchain from install.ps1, if present, over any
REM system Node/pnpm — so a vendored install "just runs".
if exist "%ROOT%.runtime\node\node.exe" (
  set "PATH=%ROOT%.runtime\node;%PATH%"
  set "COREPACK_HOME=%ROOT%.runtime\corepack"
)

echo.
echo ====================================================
echo   Heartmorrow - environment preflight
echo ====================================================
echo.

REM --- Node.js ----------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js is not installed or not on PATH.
  echo     Fix: install Node 20+ from https://nodejs.org/ ^(LTS^), then reopen this terminal.
  set /a PROBLEMS+=1
) else (
  for /f "tokens=*" %%v in ('node -v') do set "NODE_VER=%%v"
  REM Strip leading "v" then take the major version number.
  set "NODE_NUM=!NODE_VER:v=!"
  for /f "tokens=1 delims=." %%m in ("!NODE_NUM!") do set "NODE_MAJOR=%%m"
  if !NODE_MAJOR! LSS 20 (
    echo [X] Node.js !NODE_VER! is too old ^(need ^>=20^).
    echo     Fix: install Node 20+ from https://nodejs.org/ ^(LTS recommended^).
    set /a PROBLEMS+=1
  ) else (
    echo [OK] Node.js !NODE_VER!
  )
)

REM --- pnpm -------------------------------------------------------------------
where pnpm >nul 2>&1
if errorlevel 1 (
  echo [X] pnpm is not installed or not on PATH.
  echo     Fix: npm i -g pnpm     ^(corepack enable fails with EPERM on Windows^)
  set /a PROBLEMS+=1
) else (
  for /f "tokens=*" %%v in ('pnpm -v') do set "PNPM_VER=%%v"
  echo [OK] pnpm !PNPM_VER!
)

REM --- Dependencies installed & in sync with the lockfile ---------------------
call :checkdeps

REM --- Workspace esbuild build approval --------------------------------------
findstr /c:"esbuild: true" "%ROOT%pnpm-workspace.yaml" >nul 2>&1
if errorlevel 1 (
  echo [^^!] pnpm-workspace.yaml is missing 'allowBuilds: esbuild: true'.
  echo     Without it esbuild's postinstall is blocked and tsx/vite may not run.
) else (
  echo [OK] esbuild build approved in pnpm-workspace.yaml
)

REM --- .env (optional) --------------------------------------------------------
if not exist "%ROOT%.env" (
  echo [^^!] No .env file ^(optional^). Defaults will be used.
  echo     LLM features need a provider - copy .env.example to .env and set LLM_BASE_URL/LLM_MODEL.
  echo     Example local provider: LM Studio / Ollama at http://localhost:1234/v1
) else (
  echo [OK] .env present
)

REM --- Port availability (8787 server, 5173 web) ------------------------------
call :checkport 8787 server
call :checkport 5173 web

echo.
if !PROBLEMS! GTR 0 (
  echo ====================================================
  echo   !PROBLEMS! blocking problem^(s^) found. Fix the [X] items above, then re-run.
  echo ====================================================
  echo.
  endlocal
  exit /b 1
)

echo ====================================================
echo   All checks passed. Building production assets...
echo ====================================================
echo.

call pnpm run build:app
if errorlevel 1 (
  echo.
  echo ====================================================
  echo   Production build failed. Fix the errors above, then re-run.
  echo ====================================================
  echo.
  endlocal
  exit /b 1
)

echo.
echo ====================================================
echo   Starting Heartmorrow ^(pnpm start^)...
echo   Server: http://localhost:8787    Web: %APP_URL%
echo ====================================================
echo.

call :openbrowser
endlocal
pnpm start
exit /b %errorlevel%

REM ---------------------------------------------------------------------------
:checkdeps
REM Verify node_modules exists and matches the current lockfile; auto-sync if not.
REM pnpm stores a copy of the lockfile it installed from at
REM node_modules\.pnpm\lock.yaml. If it no longer matches pnpm-lock.yaml (e.g.
REM after a git pull bumped a dependency), the install is stale - reconcile it.
if not exist "%ROOT%node_modules" (
  echo [X] Dependencies are not installed ^(no node_modules^).
  echo     Fix: install.ps1   ^(or: pnpm install^)
  set /a PROBLEMS+=1
  goto :eof
)
set "DEPS_SYNCED=1"
if not exist "%ROOT%node_modules\.pnpm\lock.yaml" (
  set "DEPS_SYNCED=0"
) else (
  fc /b "%ROOT%pnpm-lock.yaml" "%ROOT%node_modules\.pnpm\lock.yaml" >nul 2>&1
  if errorlevel 1 set "DEPS_SYNCED=0"
)
if "%DEPS_SYNCED%"=="1" (
  echo [OK] node_modules present and in sync with the lockfile
  goto :eof
)
echo [^^!] Dependencies are out of date ^(pnpm-lock.yaml changed since the last install^).
if /I "%NO_AUTO_INSTALL%"=="1" (
  echo [X] Auto-sync is disabled ^(NO_AUTO_INSTALL=1^).
  echo     Fix: pnpm install   ^(then re-run run.bat^)
  set /a PROBLEMS+=1
  goto :eof
)
where pnpm >nul 2>&1
if errorlevel 1 (
  echo [X] Cannot auto-sync because pnpm is not on PATH.
  echo     Fix: install pnpm, then run install.ps1 ^(or pnpm install^).
  set /a PROBLEMS+=1
  goto :eof
)
echo     Syncing dependencies ^(pnpm install^)...
call pnpm install
if errorlevel 1 (
  echo [X] Automatic 'pnpm install' failed ^(offline? see errors above^).
  echo     Fix: run install.ps1, or 'pnpm install' manually, then re-run.
  set /a PROBLEMS+=1
  goto :eof
)
echo [OK] Dependencies synced to the current lockfile
goto :eof

REM ---------------------------------------------------------------------------
:openbrowser
REM Best-effort browser open. Set NO_BROWSER=1 to skip.
if /I "%NO_BROWSER%"=="1" (
  echo   Browser auto-open disabled ^(NO_BROWSER=%NO_BROWSER%^).
  goto :eof
)
if /I "%NO_BROWSER%"=="true" (
  echo   Browser auto-open disabled ^(NO_BROWSER=%NO_BROWSER%^).
  goto :eof
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo   Open %APP_URL% in your browser when the app is ready.
  goto :eof
)

echo   Browser will open when the web app is ready ^(set NO_BROWSER=1 to skip^).
set "HEARTMORROW_OPEN_URL=%APP_URL%"
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$u=$env:HEARTMORROW_OPEN_URL; $ok=$false; for($i=0; $i -lt 60; $i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 1; if($r.StatusCode -ge 200){ $ok=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if($ok){ Start-Process $u }" >nul 2>nul
goto :eof

REM ---------------------------------------------------------------------------
:checkport
REM %1 = port, %2 = label. Warns (does not block) if the port is in use.
netstat -ano | findstr /r /c:":%~1 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [OK] Port %~1 ^(%~2^) is free
) else (
  echo [^^!] Port %~1 ^(%~2^) is already in use.
  echo     Fix: stop the other process, or find it with:  netstat -ano ^| findstr :%~1
)
goto :eof
