@echo off
chcp 65001 >nul
title AGY Roleplay Studio - Backend Server
cd /d "%~dp0server"
echo ============================================================
echo   Запуск AGY Roleplay Studio Server (Google Antigravity CLI)
echo ============================================================
node index.js
pause
