import type { ProjectSnapshot, SessionRecord } from './model/session.js';

/**
 * Called by `create` with the other sessions recorded for the same project root.
 * Throws to veto the creation.
 */
export type CreateGuard = (sameProject: SessionRecord[]) => void;

/**
 * Persistence port. Implementations must store the whole record atomically and
 * reject a save whose `expectedRevision` is stale (error code CONFLICT), also
 * across processes. `create` must run `guard` and insert atomically with respect
 * to other creates for the same project root.
 */
export interface SessionRepository {
  create(record: SessionRecord, guard?: CreateGuard): Promise<void>;
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
