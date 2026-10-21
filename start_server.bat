@echo off
title Face Recognition Server Launcher
color 0A
cd /d "%~dp0"
python launcher.py
if errorlevel 1 pause
