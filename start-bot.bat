@echo off
chcp 65001 >nul
title ilink-bot (WeChat personal assistant)
cd /d D:\akasha\ilink-bot
"D:\akasha\venv\Scripts\python.exe" ilink_bot.py
echo.
echo Bot stopped.
pause
