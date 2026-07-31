import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { attachmentUploadMiddleware } from '../src/controllers/inbox.controller.js';

/**
 * The browser writes the `filename` of a multipart part in UTF-8. multer decodes
 * it with `defParamCharset`, which it defaults to `latin1` — so the corruption
 * happens before any code of this project reads the name, and nothing fails.
 *
 * The middleware is exercised on its own: reaching the real route needs a
 * conversation, and the file that builds one is being edited on another branch.
 */
const echo = () => {
  const app = express();
  app.post('/upload', attachmentUploadMiddleware, (req, res) => { res.json({ originalname: (req as express.Request & { file?: { originalname: string } }).file?.originalname ?? null }); });
  return app;
};

const upload = async (filename: string) => {
  const response = await request(echo()).post('/upload').attach('file', Buffer.from('%PDF-1.7'), { filename, contentType: 'application/pdf' });
  expect(response.status).toBe(200);
  return response.body.originalname as string | null;
};

describe('multipart filename decoding', () => {
  it('reads an accented filename as UTF-8 instead of latin1', async () => {
    expect(await upload('Relatório Anual.pdf')).toBe('Relatório Anual.pdf');
  });

  it('keeps the mojibake signature out of the decoded name', async () => {
    const decoded = await upload('Proposta Comercial — Ação.pdf');
    expect(decoded).toBe('Proposta Comercial — Ação.pdf');
    // `Ã` followed by a continuation byte is the signature of UTF-8 read as
    // latin1; it is what `Ação` becomes when the charset is wrong.
    expect(decoded).not.toMatch(/[ÃÂ][-¿]/);
  });

  it('carries a non-latin alphabet through undamaged', async () => {
    expect(await upload('日本語.pdf')).toBe('日本語.pdf');
    expect(await upload('Договор.pdf')).toBe('Договор.pdf');
  });

  it('leaves a plain ASCII name exactly as it was', async () => {
    expect(await upload('contrato.pdf')).toBe('contrato.pdf');
  });
});
