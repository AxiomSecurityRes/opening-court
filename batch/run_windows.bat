@echo off
chcp 65001 >nul
rem ================================================================
rem  오프닝 법정 AI 점수 계산 (Windows)
rem  아래 두 줄만 자기 환경에 맞게 고치고 더블클릭하세요.
rem ================================================================
set STOCKFISH=C:\chess\stockfish\stockfish-windows-x86-64-avx2.exe
set LICHESS_TOKEN=lip_여기에_토큰을_붙여넣기

if exist build\Release\oc_batch.exe (set BIN=build\Release\oc_batch.exe) else (set BIN=oc_batch.exe)

%BIN% --stockfish "%STOCKFISH%" --openings openings.tsv --out out --cache cache --depth 18 --threads 4 --hash 512
if errorlevel 1 goto fail

copy /Y out\ai_scores.js ..\web\data\ai_scores.js >nul
echo.
echo 끝! out\ai_scores.sql 내용을 Supabase SQL Editor 에 붙여 넣고 Run 하세요.
pause
exit /b 0

:fail
echo.
echo 실패했어요. 위 오류 메시지를 확인하세요. 같은 명령을 다시 실행하면 캐시 덕분에 이어서 계산합니다.
pause
exit /b 1
