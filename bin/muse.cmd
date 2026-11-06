@echo off
setlocal
node "%~dp0..\src\install\launcher.js" %*
exit /b %ERRORLEVEL%
