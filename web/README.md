# Runtime local

Na pasta `web`, execute `npm run dev:local`.

O comando compila contracts e inicia API (`http://127.0.0.1:3000`), worker interno (`127.0.0.1:3101`) e dashboard (`http://127.0.0.1:5173`). Ele fixa SQLite local e desativa conexão e modo demo do WhatsApp. Use `Ctrl+C` para encerrar os três processos.

O dashboard usa o proxy Vite para `/api`; a API também aceita somente as origens locais `127.0.0.1:5173` e `localhost:5173`. O header `x-workspace-id` é enviado pelo cliente HTTP central com `default-workspace` (ou `VITE_WORKSPACE_ID`).
