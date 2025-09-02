@echo off
cd /d "%~dp0"
start "kilo-openai-proxy" powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%CD%'; npm start"
