import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../../core/errors.js';
import type { SessionRecord } from '../../core/model/session.js';
import type { CreateGuard, SessionRepository } from '../../core/ports.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REVISION_FILE = /^(\d+)\.json$/;
const KEEP_REVISIONS = 5;
const CREATE_RETRIES = 20;

/**
 * Local-first store. Each session is a directory of immutable revision files:
 *
 *   <dir>/sessions/<id>/<revision>.json
 *
 * A new revision is published by hard-linking a fully written temp file to its
 * final name. `link` fails if the name exists, so publishing revision N+1 is an
 * atomic compare-and-swap across processes: two writers holding revision N can
 * never both succeed, and readers never see a partial file. No lock files, so
 * nothing is left behind by a crash.
 *
 * Starting a session claims the next number in a per-project sequence
 * (`<dir>/projects/<hash>/<n>.json`) the same way, which makes "check for an
 * active session, then create" atomic across processes.
 *
 * The directory ignores itself in git.
 */
export class FileSessionRepository implements SessionRepository {
  private ready?: Promise<void>;

  constructor(private readonly dir: string) {}

  private get sessionsDir(): string {
    return join(this.dir, 'sessions');
  }

  private sessionDir(id: string): string {
    if (!SAFE_ID.test(id)) throw new DomainError('NOT_FOUND', `Invalid session id '${id}'.`);
    return join(this.sessionsDir, id);
  }

  private projectDir(root: string): string {
    return join(this.dir, 'projects', createHash('sha256').update(root).digest('hex').slice(0, 24));
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

  async create(record: SessionRecord, guard?: CreateGuard): Promise<void> {
    await this.init();
    const project = this.projectDir(record.projectRoot);
    await mkdir(project, { recursive: true });
    for (let attempt = 0; attempt < CREATE_RETRIES; attempt++) {
      // Order matters: snapshot the sequence, check, publish our record, then claim.
      // A racing creator that loses the claim re-checks and sees the winner's record.
      const seq = await latestRevision(project);
      const peers = (await this.list()).filter((r) => r.projectRoot === record.projectRoot && r.id !== record.id);
      guard?.(peers);

      record.revision = 1;
      await mkdir(this.sessionDir(record.id), { recursive: true });
      if (!(await publish(this.sessionDir(record.id), 1, record))) {
        throw new DomainError('CONFLICT', `Session ${record.id} already exists.`);
      }
      if (await publish(project, seq + 1, { sessionId: record.id })) return;

      await rm(this.sessionDir(record.id), { recursive: true, force: true });
    }
    throw new DomainError('CONFLICT', 'Too many concurrent session starts on this project. Retry.');
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    const dir = this.sessionDir(id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const rev = await latestRevision(dir);
      if (rev === 0) return undefined;
      try {
        return parseRecord(await readFile(join(dir, `${rev}.json`), 'utf8'), id);
      } catch (e) {
        // Pruned by a concurrent writer between listing and reading: look again.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    throw new DomainError('CONFLICT', `Session ${id} is changing too quickly to read. Retry.`);
  }

  async save(record: SessionRecord, expectedRevision: number): Promise<void> {
    await this.init();
    const dir = this.sessionDir(record.id);
    const current = await latestRevision(dir);
    if (current === 0) throw new DomainError('NOT_FOUND', `Unknown session '${record.id}'.`);
    const conflict = () =>
      new DomainError(
        'CONFLICT',
        `Session ${record.id} was changed by another writer (revision ${current}, expected ${expectedRevision}). Re-read and retry.`,
      );
    if (current !== expectedRevision) throw conflict();
    const next = { ...record, revision: expectedRevision + 1 };
    if (!(await publish(dir, next.revision, next))) throw conflict();
    record.revision = next.revision;
    await prune(dir, next.revision);
  }

  /** Unreadable records are skipped so one bad session cannot hide the rest. */
  async list(): Promise<SessionRecord[]> {
    await this.init();
    const ids = (await readdir(this.sessionsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SAFE_ID.test(e.name))
      .map((e) => e.name);
    const records = await Promise.all(ids.map((id) => this.load(id).catch(() => undefined)));
    return records.filter((r): r is SessionRecord => r !== undefined);
  }
}

function parseRecord(raw: string, id: string): SessionRecord {
  const record = JSON.parse(raw) as SessionRecord;
  if (record.schemaVersion !== 1) {
    throw new Error(`Session ${id} has unsupported schemaVersion ${String(record.schemaVersion)}.`);
  }
  return record;
}

async function latestRevision(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  let max = 0;
  for (const n of names) {
    const m = REVISION_FILE.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Atomically create `<dir>/<n>.json` with `value`. Returns false if it already exists. */
async function publish(dir: string, n: number, value: unknown): Promise<boolean> {
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await link(tmp, join(dir, `${n}.json`));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function prune(dir: string, latest: number): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.map((n) => {
      const m = REVISION_FILE.exec(n);
      return m && Number(m[1]) <= latest - KEEP_REVISIONS ? unlink(join(dir, n)).catch(() => undefined) : undefined;
    }),
  );
}
