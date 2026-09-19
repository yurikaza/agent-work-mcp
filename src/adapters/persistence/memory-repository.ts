import { DomainError } from '../../core/errors.js';
import type { SessionRecord } from '../../core/model/session.js';
import type { CreateGuard, SessionRepository } from '../../core/ports.js';

/** Stores serialized copies, so callers can never mutate stored state by reference. */
export class MemorySessionRepository implements SessionRepository {
  private readonly records = new Map<string, string>();

  /** Guard and insert run synchronously, so concurrent creates cannot interleave. */
  async create(record: SessionRecord, guard?: CreateGuard): Promise<void> {
    if (this.records.has(record.id)) throw new DomainError('CONFLICT', `Session ${record.id} already exists.`);
    guard?.(
      [...this.records.values()]
        .map((raw) => JSON.parse(raw) as SessionRecord)
        .filter((r) => r.projectRoot === record.projectRoot),
    );
    record.revision = 1;
    this.records.set(record.id, JSON.stringify(record));
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    const raw = this.records.get(id);
    return raw ? (JSON.parse(raw) as SessionRecord) : undefined;
  }

  async save(record: SessionRecord, expectedRevision: number): Promise<void> {
    const current = await this.load(record.id);
    if (!current) throw new DomainError('NOT_FOUND', `Unknown session '${record.id}'.`);
    if (current.revision !== expectedRevision) {
      throw new DomainError('CONFLICT', `Session ${record.id} changed concurrently (revision ${current.revision}, expected ${expectedRevision}).`);
    }
    record.revision = expectedRevision + 1;
    this.records.set(record.id, JSON.stringify(record));
  }

  async list(): Promise<SessionRecord[]> {
    return [...this.records.values()].map((raw) => JSON.parse(raw) as SessionRecord);
  }
}
