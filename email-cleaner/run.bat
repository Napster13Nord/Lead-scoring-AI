@echo off
chcp 65001 >nul
title Email Cleaner

echo.
echo ============================================
echo          EMAIL CLEANER - Cold Email
echo ============================================
echo.

REM ── Check if a file was dragged onto the bat ──
if "%~1"=="" (
    echo [ERRO] Nenhum arquivo foi fornecido!
    echo.
    echo Como usar:
    echo   1. Arraste um arquivo .csv para cima deste .bat
    echo   2. OU execute: run.bat "caminho\para\arquivo.csv"
    echo.
    pause
    exit /b 1
)

REM ── Check Node.js is installed ──
where node >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado!
    echo.
    echo Instale o Node.js em: https://nodejs.org
    echo.
    pause
    exit /b 1
)

REM ── Get the directory where this bat file lives ──
set "SCRIPT_DIR=%~dp0"

echo Arquivo selecionado: %~nx1
echo.

REM ── Run the cleaner ──
node "%SCRIPT_DIR%email_cleaner.js" "%~1"

echo.
echo ============================================
echo Pressione qualquer tecla para fechar...
pause >nul
