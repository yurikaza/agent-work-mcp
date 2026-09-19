import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../../core/errors.js';
import type { SessionRecord } from '../../core/model/session.js';
import type { SessionRepository } from '../../core/ports.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * One JSON document per session under `<dir>/sessions/`. Writes go to a temp
 * file and are renamed into place, so a crash never leaves a torn record.
 * The directory ignores itself in git.
 */
export class FileSessionRepository implements SessionRepository {
  private ready?: Promise<void>;

  constructor(private readonly dir: string) {}

  private get sessionsDir(): string {
    return join(this.dir, 'sessions');
  }

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new DomainError('NOT_FOUND', `Invalid session id '${id}'.`);
    return join(this.sessionsDir, `${id}.json`);
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.sessionsDir, { recursive: true });
      await writeFile(join(this.dir, '.gitignore'), '# agent-work-mcp local state\n*\n', { flag: 'wx' }).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e;
        },
      );
    })();
    return this.ready;
  }

  async create(record: SessionRecord): Promise<void> {
    await this.init();
    if (await this.load(record.id)) throw new DomainError('CONFLICT', `Session ${record.id} already exists.`);
    record.revision = 1;
    await this.write(record);
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.file(id), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    const record = JSON.parse(raw) as SessionRecord;
    if (record.schemaVersion !== 1) {
      throw new Error(`Session ${id} has unsupported schemaVersion ${String(record.schemaVersion)}.`);
    }
    return record;
  }

  async save(record: SessionRecord, expectedRevision: number): Promise<void> {
    await this.init();
    const current = await this.load(record.id);
    if (!current) throw new DomainError('NOT_FOUND', `Unknown session '${record.id}'.`);
    if (current.revision !== expectedRevision) {
      throw new DomainError(
        'CONFLICT',
        `Session ${record.id} was changed by another process (revision ${current.revision}, expected ${expectedRevision}). Re-read and retry.`,
      );
    }
    record.revision = expectedRevision + 1;
    await this.write(record);
  }

  async list(): Promise<SessionRecord[]> {
    await this.init();
    const names = (await readdir(this.sessionsDir)).filter((n) => n.endsWith('.json') && SAFE_ID.test(n.slice(0, -5)));
    const records = await Promise.all(names.map((n) => this.load(n.slice(0, -'.json'.length))));
    return records.filter((r): r is SessionRecord => r !== undefined);
  }

  private async write(record: SessionRecord): Promise<void> {
    const target = this.file(record.id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
  }
}
