@echo off
title Ethereum Quantitative Trading Platform - Full Stack Launcher
echo ===============================================================================
echo   ETH/USDT INSTITUTIONAL QUANTITATIVE TRADING PLATFORM (FULL STACK)
echo   Python 5-Strategy Ensemble (Port 8000) + Vite Real-Time Dashboard (Port 3000)
echo ===============================================================================
echo.

echo [1/2] Starting Python Quantitative Backend on http://127.0.0.1:8000...
start "Python Quant Engine (ETHUSDT)" cmd /k "cd backend && python run.py api"

echo [2/2] Starting Frontend Dashboard on http://localhost:3000...
start "Frontend Dashboard (Vite)" cmd /k "npm run dev"

echo.
echo ===============================================================================
echo   Both services have been launched in separate windows!
echo   Frontend:  http://localhost:3000
echo   API Docs:  http://127.0.0.1:8000/docs
echo   WebSocket: ws://127.0.0.1:8000/ws/live
echo ===============================================================================
pause
