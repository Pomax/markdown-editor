@echo off
setlocal EnableDelayedExpansion
for %%R in ("%~dp0..") do set "ROOT=%%~fR"
set "ARGS="
set "FIRST="
for %%A in (%*) do (
  set "ARG=%%~A"
  if not "!ARG:~0,1!"=="-" (
    set "ARG=%%~fA"
    set "ARG=!ARG:%ROOT%\=!"
    set "ARG=!ARG:\=/!"
  )
  if not defined FIRST set "FIRST=!ARG!"
  set ARGS=!ARGS! "!ARG!"
)
cd /d "%ROOT%"
if not defined FIRST (
  call npm test
) else (
  echo !FIRST!| findstr /i /r "\.test\.js$" >nul
  if errorlevel 1 (
    call npm run test:integration -- !ARGS!
  ) else (
    call node --test !ARGS!
  )
)
exit /b !errorlevel!
