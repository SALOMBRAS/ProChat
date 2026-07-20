import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/errors.js';

describe('attachment error mapping', () => {
  it.each([
    [new multer.MulterError('LIMIT_FILE_SIZE'), 413, 'Arquivo excede o limite permitido'],
    [new multer.MulterError('LIMIT_UNEXPECTED_FILE'), 400, 'Arquivo inválido'],
  ])('returns a structured response and leaves health available', async (error, status, message) => {
    const app = express();
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.post('/attachments', (_req, _res, next) => next(error));
    app.use(errorHandler);
    await request(app).post('/attachments').expect(status).expect(response => expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message }));
    await request(app).get('/health').expect(200).expect(response => expect(response.body).toEqual({ status: 'ok' }));
  });
});
