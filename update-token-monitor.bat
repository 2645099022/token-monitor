@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

title Token Monitor - Updater
cd /d "%~dp0"

REM --- Network: set your proxy or mirror here --------------------------------
REM   7897 is your local proxy port. Toggle the lines you need.
REM   Tip: if the proxy is flaky, swap to ELECTRON_MIRROR alone.
set "HTTP_PROXY=http://127.0.0.1:7897"
set "HTTPS_PROXY=http://127.0.0.1:7897"
REM set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

echo ============================================
echo   Token Monitor - Auto Updater
echo ============================================
echo.

REM Temp files: created up front so :cleanup can always remove them.
set "TMPSTATUS=%TEMP%\tmu-status-%RANDOM%.txt"
set "TMPREAL=%TEMP%\tmu-real-%RANDOM%.txt"
set "TMPWHITE=%TEMP%\tmu-white-%RANDOM%.txt"

REM --- 0. Sanity: git and node/npm available ----------------------------------
where git >nul 2>nul
if errorlevel 1 (
  echo [X] git not found. Install Git for Windows first.
  set "EC=1" & goto :cleanup
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [X] npm not found. Install Node.js first.
  set "EC=1" & goto :cleanup
)

REM --- 1. Inside a git repo on main -------------------------------------------
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo [X] This folder is not a git repository.
  echo     Run:  git init ^&^& git remote add origin https://github.com/Javis603/token-monitor.git
  set "EC=1" & goto :cleanup
)
for /f "delims=" %%b in ('git branch --show-current 2^>nul') do set "BRANCH=%%b"
if not "!BRANCH!"=="main" (
  echo [X] Current branch is "!BRANCH!", expected "main".
  echo     Switch with:  git checkout main
  set "EC=1" & goto :cleanup
)

REM --- 2. Reject if working tree is dirty (with whitelist) --------------------
REM    WHITELIST: pipe-separated patterns. Case-insensitive.
REM      - Bare name match:           update-token-monitor.bat
REM      - Wildcard with `*`:         *.bat   scratch-*
REM      - End with `\` for a dir:    docs\personal\
REM    Add or remove entries here when the set of "noise" files changes.
set "WHITELIST=*.bat|update-token-monitor.bat|start-token-monitor.bat"

REM `for /f` on cmd.exe expects CRLF; PowerShell's Out-File on ASCII
REM reliably gives CRLF on Windows PowerShell 5.1 (default on Win10/11).
powershell -NoProfile -Command "git -c core.autocrlf=false status --porcelain --untracked-files=all | Out-File -FilePath '%TMPSTATUS%' -Encoding ASCII" >nul 2>nul
if errorlevel 1 (
  echo [X] git status failed.
  set "EC=1" & goto :cleanup
)

set "REAL_DIRTY="
set "WHITELISTED="

REM Iterate each status line. For each line, iterate the patterns (split on
REM `|`). We use `for /f` with `delims=|` because `for` does filename glob
REM on bare `*` patterns in the `in` clause, which is exactly what we DON'T
REM want here.
for /f "usebackq delims=" %%L in ("%TMPSTATUS%") do (
  set "LINE=%%L"
  set "PP=!LINE:~3!"
  if not defined PP set "PP=!LINE!"

  set "CAT=DIRTY"
  set "HIT2="

  for /f "delims=|" %%P in ("%WHITELIST%") do (
    set "PAT=%%P"
    if "!CAT!"=="DIRTY" (
      if /i "!PP!"=="!PAT!" (
        set "CAT=WHITELIST" & set "HIT2=!PAT!"
      ) else if "!PAT:~-1!"=="\" (
        if /i "!PP:~0,-1!"=="!PAT:~0,-1!" (
          set "CAT=WHITELIST" & set "HIT2=!PAT!"
        )
      ) else (
        set "HEAD_STAR="
        set "TAIL_STAR="
        set "BODY=!PAT!"
        if "!BODY:~0,1!"=="*" set "HEAD_STAR=1"
        if "!BODY:~-1!"=="*" set "TAIL_STAR=1"
        if defined HEAD_STAR set "BODY=!BODY:~1!"
        if defined TAIL_STAR set "BODY=!BODY:~0,-1!"
        if defined BODY (
          if defined HEAD_STAR if defined TAIL_STAR (
            echo(!PP!| findstr /i /c:"!BODY!" >nul && (
              set "CAT=WHITELIST" & set "HIT2=!PAT!"
            )
          ) else if defined HEAD_STAR (
            echo(!PP!| findstr /i /e /c:"!BODY!" >nul && (
              set "CAT=WHITELIST" & set "HIT2=!PAT!"
            )
          ) else if defined TAIL_STAR (
            if /i "!PP:~0,200!"=="!BODY!" (
              set "CAT=WHITELIST" & set "HIT2=!PAT!"
            )
          )
        )
      )
    )
  )

  if "!CAT!"=="WHITELIST" (
    set "WHITELISTED=!WHITELISTED!  !LINE!  ^<- whitelisted: !HIT2!"
  ) else (
    set "REAL_DIRTY=!REAL_DIRTY!  !LINE!"
  )
)

if defined REAL_DIRTY (
  echo [X] Working tree has uncommitted changes. Refusing to update.
  echo.
  echo     Non-whitelisted changes:
  for /f "delims=" %%R in ("!REAL_DIRTY!") do (
    for /f "tokens=*" %%S in ("%%R") do echo       %%S
  )
  if defined WHITELISTED (
    echo.
    echo     Whitelisted ^(ignored^):
    for /f "delims=" %%W in ("!WHITELISTED!") do (
      for /f "tokens=*" %%S in ("%%W") do echo       %%S
    )
  )
  echo.
  echo     Stash, commit, or discard them first, then re-run this script.
  echo     To whitelist a path, edit the WHITELIST variable at the top of
  echo     this script.
  set "EC=1" & goto :cleanup
)

REM --- 3. Compare current HEAD with origin/main -------------------------------
echo [1/4] Fetching origin...
git fetch origin
if errorlevel 1 (
  echo [X] git fetch failed. Check network or credentials.
  set "EC=1" & goto :cleanup
)

for /f "delims=" %%c in ('git rev-list --count HEAD..origin/main 2^>nul') do set "BEHIND=%%c"
if not defined BEHIND set "BEHIND=0"

if "!BEHIND!"=="0" (
  echo.
  echo [OK] Already up to date. Current HEAD:
  git log --oneline -1
  goto :after_update
)

echo.
echo [2/4] Pulling !BEHIND! new commit^(s^) from origin/main...
git pull --ff-only origin main
if errorlevel 1 (
  echo [X] git pull --ff-only failed. Your branch may have diverged.
  echo     Resolve manually with:  git status   /   git rebase origin/main
  set "EC=1" & goto :cleanup
)

echo.
echo [3/4] Checking if dependencies need refresh...
git diff --quiet HEAD~1 HEAD -- package.json package-lock.json 2>nul
set "DEPS_CHANGED=!errorlevel!"
if not "!DEPS_CHANGED!"=="0" (
  echo     package.json or package-lock.json changed - running npm install...
  call npm install
  if errorlevel 1 (
    echo [X] npm install failed. Check the output above.
    set "EC=1" & goto :cleanup
  )
) else (
  echo     No dependency changes - skipping npm install.
)

:after_update
echo.
echo [4/4] Done.
echo.
echo Current version:
for /f "delims=" %%v in ('node -p "require('./package.json').version" 2^>nul') do echo     v%%v
echo.
echo Latest release tag on GitHub:
git describe --tags --abbrev=0 2>nul
echo.
set "START_CHOICE="
set /p "START_CHOICE=Start Token Monitor now? [y/N]: "
if /i "!START_CHOICE!"=="y" (
  echo.
  echo Starting...
  call npm start
)

set "EC=0" & goto :cleanup

:cleanup
del /q "%TMPSTATUS%" "%TMPREAL%" "%TMPWHITE%" 2>nul
if defined EC (
  if not "!EC!"=="0" pause
) else (
  pause
)
endlocal & exit /b !EC!
