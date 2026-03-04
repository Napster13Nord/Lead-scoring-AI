@echo off
chcp 65001 >nul
title LinkedIn Merge

echo.
echo ============================================
echo      LINKEDIN MERGE - Junta listas
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado!
    echo Instale em: https://nodejs.org
    echo.
    pause
    exit /b 1
)

set "SCRIPT_DIR=%~dp0"

echo Iniciando merge com os arquivos padrao em data\...
echo   File 1: Linkedin Scrape, v1 ^(lista principal^)
echo   File 2: merged_leads_finder ^(contatos LinkedIn^)
echo.

node "%SCRIPT_DIR%..\scripts\merge_linkedin.js"

echo.
echo ============================================
echo Pressione qualquer tecla para fechar...
pause >nul
