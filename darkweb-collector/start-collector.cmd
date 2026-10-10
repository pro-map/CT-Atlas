@echo off
rem CT Atlas Dark Web collector - Bessira daily one-shot mode.
rem Run Tor Browser first, then launch this file.
rem The collector checks Bessira's current listing, opens only genuinely new
rem publications visible there, sends them to CT Atlas, then exits.
rem It does not crawl historical pages and does not repeat every few minutes.
cd /d "%~dp0"
title CT Atlas - Bessira daily update
if not defined DARKWEB_INGEST_TOKEN set /p "DARKWEB_INGEST_TOKEN=Paste the collector secret and press Enter: "
py collector.py --proxy socks5h://127.0.0.1:9150 --once --pages-per-scan 100 --connect-timeout 120
set "CT_ATLAS_EXIT=%ERRORLEVEL%"
echo.
if "%CT_ATLAS_EXIT%"=="0" (
  echo Bessira daily update completed. The collector is now stopped.
) else (
  echo Bessira daily update ended with an error. Review the messages above.
)
exit /b %CT_ATLAS_EXIT%
