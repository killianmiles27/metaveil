@echo off
setlocal
set "CMD=%~1"
if "%CMD%"=="install" goto metaveil_install
if "%CMD%"=="uninstall" goto metaveil_install
if "%CMD%"=="acl" goto metaveil_install
if "%CMD%"=="contributor" goto metaveil_install
if "%CMD%"=="status" goto metaveil_install
node "%~dp0..\src\cli.js" %*
exit /b %ERRORLEVEL%
:metaveil_install
node "%~dp0..\src\install\cli.js" %*
exit /b %ERRORLEVEL%
