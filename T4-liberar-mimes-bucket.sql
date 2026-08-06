-- ============================================================
-- PR-T4 — Documentos, Arquivos e Links (§14.3)
-- Libera o bucket de anexos temporários para QUALQUER mime type,
-- alinhando o Storage à nova policy da API: qualquer documento
-- até 50 MB (paridade com o WhatsApp).
--
-- Como usar:
--   1. Abra o SQL Editor do Supabase da MESMA instância para a
--      qual o SUPABASE_URL do .env da API aponta.
--   2. Cole todo este arquivo e execute (Run).
--   3. A consulta de verificação no final deve retornar
--      allowed_mime_types = NULL.
--   4. Reenvie o arquivo — não precisa reiniciar a API.
-- ============================================================

-- Passo 1: remover a restrição de mime do bucket
UPDATE storage.buckets
SET allowed_mime_types = NULL
WHERE id = 'chatpro-temporary-attachments';

-- Passo 2: verificação — deve retornar allowed_mime_types = NULL
SELECT id, allowed_mime_types, file_size_limit
FROM storage.buckets
WHERE id = 'chatpro-temporary-attachments';
