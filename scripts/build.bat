@echo off
cd /d "%~dp0.."
node scripts\build-executable.js
exit /b %errorlevel%
