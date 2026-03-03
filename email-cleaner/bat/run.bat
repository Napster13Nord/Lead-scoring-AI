@echo off
chcp 65001 >nul
title Email Cleaner

echo.
echo ============================================
echo          EMAIL CLEANER - Passo 1
echo    Seleciona o melhor email de cada linha
echo ============================================
echo.

if "%~1"=="" (
    echo [ERRO] Nenhum arquivo foi fornecido!
    echo.
    echo Como usar:
    echo   Arraste um arquivo .csv para cima deste .bat
    echo.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado!
    echo Instale em: https://nodejs.org
    echo.
    pause
    exit /b 1
)

set "SCRIPT_DIR=%~dp0"
echo Arquivo: %~nx1
echo.

node "%SCRIPT_DIR%..\scripts\email_cleaner.js" "%~1"

echo.
echo ============================================
echo Pressione qualquer tecla para fechar...
pause >nul
