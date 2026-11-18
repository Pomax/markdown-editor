@echo off
for %%R in ("%~dp0..") do set "ROOT=%%~fR"
set "APP=%ROOT%\dist\windows\Markdown-Editor.exe"
if not exist "%APP%" goto missing
"%APP%" %*
exit /b %errorlevel%
:missing
echo No release build at %APP%: run scripts\build.bat first 1>&2
exit /b 1
