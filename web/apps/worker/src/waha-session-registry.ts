import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type WahaSessionRegistryEntry = { workspaceId: string; sessionId: string; name: string; wahaName: string; aliases?: string[]; phone?: string };
export class FileWahaSessionRegistry {
  private readonly file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, 'waha-sessions.json'); }
  async load(): Promise<WahaSessionRegistryEntry[]> {
    try { const data: unknown = JSON.parse(await readFile(this.file, 'utf8')); return Array.isArray(data) ? data.filter(isEntry) : []; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async save(entries: WahaSessionRegistryEntry[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true }); const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(entries), 'utf8'); await rename(temporary, this.file);
  }
}
function isEntry(value: unknown): value is WahaSessionRegistryEntry { if (!value || typeof value !== 'object') return false; const record = value as Record<string, unknown>; const aliases = record.aliases; return ['workspaceId', 'sessionId', 'name', 'wahaName'].every(key => typeof record[key] === 'string' && String(record[key]).length > 0) && (aliases === undefined || (Array.isArray(aliases) && aliases.every((item: unknown) => typeof item === 'string' && item.length > 0))) && (record.phone === undefined || (typeof record.phone === 'string' && record.phone.length > 0)); }
