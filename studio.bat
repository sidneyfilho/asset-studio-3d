@echo off
rem Abre o Asset Studio 3D em modo desenvolvimento (compila o que mudou e abre a janela)
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run tauri dev
