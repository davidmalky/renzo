@echo off
title Renzo Agent Pipeline
cd /d F:\davidmalky\Files\Ai\Claude\agent_pipeline
set LIVE_DEPLOY=1
echo.
echo Starting Renzo build pipeline...
echo Window will stay open when complete. You can close it manually.
echo.
python run_overnight.py tasks_renzo.json
echo.
echo ========================================
echo Pipeline finished. Check output above.
echo You can close this window now.
echo ========================================
pause
