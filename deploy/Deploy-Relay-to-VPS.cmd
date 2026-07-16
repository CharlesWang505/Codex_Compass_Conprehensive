@echo off
setlocal
title Codex Compass Relay VPS Setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-relay-from-windows.ps1"
echo.
pause
