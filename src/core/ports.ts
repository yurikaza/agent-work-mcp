import type { ProjectSnapshot, SessionRecord } from './model/session.js';

/**
 * Persistence port. Implementations must store the whole record atomically and
 * reject a save whose `expectedRevision` is stale (error code CONFLICT).
 */
export interface SessionRepository {
  create(record: SessionRecord): Promise<void>;
  load(id: string): Promise<SessionRecord | undefined>;
  /** Persists `record` as revision `expectedRevision + 1` and updates `record.revision`. */
  save(record: SessionRecord, expectedRevision: number): Promise<void>;
  list(): Promise<SessionRecord[]>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  sessionId(): string;
}

/** Cheap, read-only facts about a project: VCS state and where the docs are. */
export interface ProjectInspector {
  inspect(root: string): Promise<ProjectSnapshot>;
}

export const systemClock: Clock = { now: () => new Date() };
