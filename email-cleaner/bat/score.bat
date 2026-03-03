@echo off
chcp 65001 >nul
title Lead Scorer

echo.
echo ============================================
echo       LEAD SCORER - Passo 3
echo    Pontua leads de 0-100 por potencial
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

node "%SCRIPT_DIR%..\scripts\lead_scorer.js" "%~1"

echo.
echo ============================================
echo Pressione qualquer tecla para fechar...
pause >nul
