@echo off
REM 无头 Edge 截图：shot.cmd <输出png绝对路径> <URL> [宽] [高]
REM SSE 长连接须先经 tools/shot-proxy.mjs 掐断，否则 virtual-time-budget 永不走完
setlocal
set OUT=%~1
set URL=%~2
set W=%~3
set H=%~4
if "%W%"=="" set W=1440
if "%H%"=="" set H=900
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check --noerrdialogs --user-data-dir="%TEMP%\edge-shot-profile" --window-size=%W%,%H% --virtual-time-budget=8000 "--screenshot=%OUT%" "%URL%"
endlocal
