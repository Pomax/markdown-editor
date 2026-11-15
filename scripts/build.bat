@echo off
node "%~dp0build-executable.js"
if errorlevel 1 exit /b 1
