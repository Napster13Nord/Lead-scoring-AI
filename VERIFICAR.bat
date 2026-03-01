@echo off
chcp 65001 >nul 2>&1
title WooCommerce E-commerce Verifier
cd /d "%~dp0"

REM ======================================================
REM  COMO USAR:
REM  - Duplo clique neste ficheiro para abrir
REM  - Ou arraste um CSV para cima deste ficheiro
REM ======================================================

REM Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: Node.js nao encontrado!
    echo  Instale em: https://nodejs.org
    echo.
    pause
    exit /b 1
)

REM If a file was dragged onto this .bat, pass it as argument
if "%~1"=="" (
    node verify_ecommerce.js
) else (
    node verify_ecommerce.js "%~1"
)
