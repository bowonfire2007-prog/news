@echo off
cd /d "%~dp0"
echo === Cleaning git locks ===
if exist .git\index.lock del /f .git\index.lock
if exist .git\HEAD.lock del /f .git\HEAD.lock
echo.

echo === Preflight (syntax + structure) ===
node preflight.js
if errorlevel 1 (
  echo.
  echo Preflight FAILED - nothing was deployed. Fix the FAIL lines above and re-run.
  pause
  exit /b 1
)
echo.

echo === Deploying worker.js to Cloudflare ===
where wrangler >nul 2>&1
if errorlevel 1 (
  echo.
  echo wrangler is not installed. One-time setup:
  echo     npm install -g wrangler
  echo     wrangler login
  echo Then run this .bat again.
  echo.
  pause
  exit /b 1
)
call wrangler deploy
if errorlevel 1 (
  echo.
  echo Wrangler deploy failed. Common fixes:
  echo   - First time?    Run:  wrangler login
  echo   - Token expired? Run:  wrangler login
  echo   - Multiple CF accounts? Add account_id to wrangler.toml.
  echo.
  pause
  exit /b 1
)
echo.

echo === Pushing to GitHub ===
git add index.html worker.js wrangler.toml push.bat .gitignore lwc.min.js preflight.js
git rm --cached --ignore-unmatch news.html
git commit -m "Update dashboard"
git push
echo.
echo Done! Press any key to close.
pause
