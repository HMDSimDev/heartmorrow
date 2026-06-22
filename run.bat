@echo off
setlocal enabledelayedexpansion

REM ============================================================================
REM Heartmorrow launcher (Windows) — runs preflight checks, then `pnpm dev`.
REM Reports what's wrong and how to fix it before trying to start the app.
REM ============================================================================

set "PROBLEMS=0"
set "ROOT=%~dp0"

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

REM --- Dependencies installed -------------------------------------------------
if not exist "%ROOT%node_modules" (
  echo [X] Dependencies are not installed ^(no node_modules^).
  echo     Fix: pnpm install
  set /a PROBLEMS+=1
) else (
  echo [OK] node_modules present
)

REM --- Workspace esbuild build approval --------------------------------------
findstr /c:"esbuild: true" "%ROOT%pnpm-workspace.yaml" >nul 2>&1
if errorlevel 1 (
  echo [!] pnpm-workspace.yaml is missing 'allowBuilds: esbuild: true'.
  echo     Without it esbuild's postinstall is blocked and tsx/vite may not run.
) else (
  echo [OK] esbuild build approved in pnpm-workspace.yaml
)

REM --- .env (optional) --------------------------------------------------------
if not exist "%ROOT%.env" (
  echo [!] No .env file ^(optional^). Defaults will be used.
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
echo   All checks passed. Starting Heartmorrow ^(pnpm dev^)...
echo   Server: http://localhost:8787    Web: http://localhost:5173
echo ====================================================
echo.

endlocal
pnpm dev
exit /b %errorlevel%

REM ---------------------------------------------------------------------------
:checkport
REM %1 = port, %2 = label. Warns (does not block) if the port is in use.
netstat -ano | findstr /r /c:":%~1 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [OK] Port %~1 ^(%~2^) is free
) else (
  echo [!] Port %~1 ^(%~2^) is already in use.
  echo     Fix: stop the other process, or find it with:  netstat -ano ^| findstr :%~1
)
goto :eof
