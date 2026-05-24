@echo off
title Renzo Pipeline v3 - Phase 2
cd /d F:\davidmalky\Files\Ai\Claude\agent_pipeline
set LIVE_DEPLOY=1
set AUTO_PROPEL=1
echo.
echo ============================================================
echo   RENZO PIPELINE v3 - Phase 2 Build
echo   Budget cap: $5 total session
echo   Auto-propel: ON (stays within project vision)
echo   Close window to stop at any time
echo ============================================================
echo.
python run_v3.py tasks_renzo_v2.json
echo.
echo ============================================================
echo   Done. Check output above.
echo ============================================================
pause
