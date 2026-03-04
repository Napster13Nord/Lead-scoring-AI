@echo off
chcp 65001 >nul
title Finalize for Instantly

echo.
echo ============================================
echo     FINALIZE FOR INSTANTLY - Passo Final
echo   Corrige emails + gera CSV para campanha
echo ============================================
echo.

if "%~1"=="" (
    echo [ERRO] Nenhum arquivo foi fornecido!
    echo.
    echo Como usar:
    echo   Arraste um arquivo .xlsx merged para cima deste .bat
    echo.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado! Instale em: https://nodejs.org
    pause
    exit /b 1
)

set "SCRIPT_DIR=%~dp0"
echo Arquivo: %~nx1
echo.

node "%SCRIPT_DIR%..\scripts\finalize_instantly.js" "%~1"

echo.
echo ============================================
echo Pressione qualquer tecla para fechar...
pause >nul
