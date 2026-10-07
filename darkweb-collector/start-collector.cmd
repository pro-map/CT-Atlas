@echo off
rem CT Atlas Dark Web collector, left running in this window.
rem Whenever Tor Browser is connected (port 9150), every enabled outlet is checked
rem every 5 minutes: new publications are added and nothing is deleted. While Tor is
rem closed the passes fail quietly and resume by themselves. Close the window to stop.
rem The collector secret is asked for when it is not set, and asked again after the
rem collector stops with exit code 2 (a configuration error such as a missing or short secret).
cd /d "%~dp0"
title CT Atlas collector
:run
if not defined DARKWEB_INGEST_TOKEN set /p "DARKWEB_INGEST_TOKEN=Paste the collector secret and press Enter: "
py collector.py --proxy socks5h://127.0.0.1:9150 --interval 300 --connect-timeout 120
if errorlevel 2 if not errorlevel 3 set "DARKWEB_INGEST_TOKEN="
echo.
if not defined DARKWEB_INGEST_TOKEN echo The collector secret or settings were not accepted; see the message above. The secret is asked for again.
echo The collector stopped. It restarts in 60 seconds; close this window to stop it.
timeout /t 60 /nobreak >nul
goto run
