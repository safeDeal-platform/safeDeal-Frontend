@echo off
setlocal
pushd "%~dp0..\.." || exit /b 1
set "SAFEDEAL_REVIEW_ENV=%~1"
if not defined SAFEDEAL_REVIEW_ENV set "SAFEDEAL_REVIEW_ENV=..\review.env"
if not exist "%SAFEDEAL_REVIEW_ENV%" (
  echo SafeDeal Review configuration not found: "%SAFEDEAL_REVIEW_ENV%"
  popd
  pause
  exit /b 1
)
node --env-file="%SAFEDEAL_REVIEW_ENV%" tools\ai-review\start-review.mjs
set "SAFEDEAL_REVIEW_EXIT=%ERRORLEVEL%"
popd
if not "%SAFEDEAL_REVIEW_EXIT%"=="0" pause
exit /b %SAFEDEAL_REVIEW_EXIT%
