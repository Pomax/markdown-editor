@echo off
cd /d "%~dp0.."
if "%~1"=="" (
  call npm test
  goto :done
)
echo %~1 | findstr /i /r "\.test\.js$" >nul
if errorlevel 1 (
  call npx playwright test %*
) else (
  call node --test %*
)
:done
if errorlevel 1 exit /b 1
