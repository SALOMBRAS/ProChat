@echo off
REM ============================================================
REM  WaCalls - Servidor de teste local (Fase 0 - Prova de Conceito)
REM  Modo DEBUG: grava log detalhado em debug-wacalls.log
REM  Duplo clique ou rode no terminal. Para parar: Ctrl+C.
REM ============================================================
setlocal
set "ROOT=%~dp0"
set "PATH=%ROOT%..\..\tools\go\bin;%PATH%"
cd /d "%ROOT%"

echo.
echo  WaCalls rodando em: http://localhost:8080  (MODO DEBUG)
echo  Log sendo gravado em: debug-wacalls.log
echo  Abra no navegador, clique "New session" e escaneie o QR
echo  com o WhatsApp do numero de TESTE (Aparelhos conectados).
echo.
.\wacalls.exe -addr :8080 -static client/dist -db wacalls.db -debug 2> debug-wacalls.log
