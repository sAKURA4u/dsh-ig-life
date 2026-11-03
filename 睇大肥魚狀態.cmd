@echo off
chcp 65001 >nul
cd /d "%~dp0"
node tools\report.mjs
if exist report.html start "" "report.html"
pause
