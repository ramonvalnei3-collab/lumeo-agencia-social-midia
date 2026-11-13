@echo off
title Altos Sabores - sistema de caixa
cd /d "%~dp0"
node --no-warnings servidor.js
echo.
echo O sistema parou. Feche esta janela ou aperte uma tecla.
pause > nul
