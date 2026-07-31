import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeFilename } from '../src/services/attachment-outbox.service.js';

afterEach(() => vi.restoreAllMocks());

/**
 * The exact inputs measured while writing web/docs/spec-envio-documento.md. Each
 * one arrived at the contact without an extension, and none of them failed, logged
 * or fell back — that silence is why the defect survived so long.
 */
describe('attachment filename sanitization', () => {
  it('keeps the extension when the whole stem falls outside the allowlist', () => {
    expect(sanitizeFilename('日本語.pdf')).toBe('attachment.pdf');
    expect(sanitizeFilename('Договор.pdf')).toBe('attachment.pdf');
    expect(sanitizeFilename('📄.pdf')).toBe('attachment.pdf');
  });

  it('keeps the extension of a name one character past the cap instead of leaving a bare dot', () => {
    const name = `${'a'.repeat(179)}.pdf`;
    expect(name).toHaveLength(183);
    const result = sanitizeFilename(name);
    expect(result).toHaveLength(180);
    expect(result.endsWith('.pdf')).toBe(true);
    expect(result.endsWith('.')).toBe(false);
  });

  it('keeps the extension of a name past the cap instead of truncating it away', () => {
    const name = `${'a'.repeat(180)}.pdf`;
    expect(name).toHaveLength(184);
    const result = sanitizeFilename(name);
    expect(result).toHaveLength(180);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('truncates the stem rather than the tail, however long the name is', () => {
    const result = sanitizeFilename(`${'a'.repeat(400)}.docx`);
    expect(result).toHaveLength(180);
    expect(result.endsWith('.docx')).toBe(true);
    expect(result.startsWith('aaaa')).toBe(true);
  });

  it('still collapses a path into a single segment, because the name is a storage key', () => {
    expect(sanitizeFilename('../../photo.jpg')).toBe('photo.jpg');
    expect(sanitizeFilename('../../photo.jpg')).not.toContain('..');
    expect(sanitizeFilename('a/b/c.pdf')).not.toContain('/');
  });

  it('leaves an ordinary name untouched and folds accents into the stem only', () => {
    expect(sanitizeFilename('contrato.pdf')).toBe('contrato.pdf');
    expect(sanitizeFilename('nota fiscal 123.pdf')).toBe('nota-fiscal-123.pdf');
    expect(sanitizeFilename('Relatório Anual.pdf')).toBe('Relato-rio-Anual.pdf');
  });

  it('falls back only when nothing survives, and never invents an extension', () => {
    expect(sanitizeFilename('...')).toBe('attachment');
    expect(sanitizeFilename('   ')).toBe('attachment');
    expect(sanitizeFilename('')).toBe('attachment');
    expect(sanitizeFilename('文件')).toBe('attachment');
  });

  it('does not persist a separator left dangling by the cut', () => {
    // The stem is cleaned to 175 letters, a separator, then more letters — so the
    // cut at 176 lands exactly on the separator. Trimming only before the cut, as
    // the first version did, would store `aaa…a-.pdf`.
    const result = sanitizeFilename(`${'a'.repeat(175)} ${'b'.repeat(20)}.pdf`);
    expect(result).toBe(`${'a'.repeat(175)}.pdf`);
    expect(result).not.toContain('-.');
  });

  it('never exceeds the cap, even when the tail is long enough to look like an extension', () => {
    expect(sanitizeFilename(`a.${'b'.repeat(400)}`).length).toBeLessThanOrEqual(180);
    expect(sanitizeFilename(`${'a'.repeat(300)}.${'b'.repeat(300)}`).length).toBeLessThanOrEqual(180);
  });

  it('says out loud that it fell back, without putting the customer name in the log', () => {
    const console_ = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    sanitizeFilename('日本語.pdf');
    const lines = console_.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', originalLength: 7, extension: '.pdf' });
    expect(lines[0]).not.toContain('日本語');

    console_.mockClear();
    sanitizeFilename('contrato.pdf');
    expect(console_.mock.calls).toHaveLength(0);
  });

  it('treats a tail that is not an extension as part of the name', () => {
    // A leading dot is a hidden file, not an extension: the stem is empty and the
    // dot is a border, so the old trim result is the right one here.
    expect(sanitizeFilename('.pdf')).toBe('pdf');
    // Too long to be an extension, and not ASCII alphanumeric: both stay in the stem.
    expect(sanitizeFilename('backup.2026conferencia')).toBe('backup.2026conferencia');
    expect(sanitizeFilename('arquivo.документ')).toBe('arquivo');
  });
});
