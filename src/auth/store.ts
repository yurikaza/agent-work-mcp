import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * File-backed state for the authorization server, under `<stateDir>/auth/`:
 *
 *   auth/clients/<client_id>.json          registered clients (RFC 7591)
 *   auth/codes/<sha256(code)>.json         authorization codes, one-time use
 *   auth/tokens/<sha256(token)>.json       access and refresh tokens
 *
 * No secret is ever written to disk. A code or token is stored under the
 * hex SHA-256 of its value, so a leaked state directory cannot be replayed
 * against the server; verification hashes the presented value and looks for
 * that file.
 *
 * The store lives on the same volume as session state, which makes an issued
 * token survive a redeploy — the point of hosting at all.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** A registered client. Public (no secret): PKCE is what authenticates the exchange. */
export interface ClientRecord {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  client_name?: string;
  scope?: string;
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
}

/** An authorization code grant, consumed by the first `/token` call that presents it. */
export interface CodeRecord {
  clientId: string;
  redirectUri: string;
  /** PKCE challenge (S256, base64url). The verifier never reaches the server until exchange. */
  codeChallenge: string;
  scope: string;
  /** RFC 8707 `resource`, recorded for audit; see the note in `server.ts`. */
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  kind: 'access' | 'refresh';
  clientId: string;
  scope: string;
  resource?: string;
  /** Seconds since the epoch, matching `AuthInfo.expiresAt`. */
  expiresAt: number;
}

/** Hex SHA-256 — the on-disk name of a code or token. */
export function secretHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 256 bits of randomness, URL-safe: used for client ids, codes and tokens. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export class AuthStore {
  private ready?: Promise<void>;
  private sweptAt = 0;

  constructor(private readonly dir: string) {}

  private init(): Promise<void> {
    this.ready ??= (async () => {
      for (const sub of ['clients', 'codes', 'tokens']) await mkdir(join(this.dir, sub), { recursive: true });
    })();
    return this.ready;
  }

  private path(kind: 'clients' | 'codes' | 'tokens', name: string): string {
    if (!SAFE_ID.test(name)) throw new Error(`Invalid ${kind} key.`);
    return join(this.dir, kind, `${name}.json`);
  }

  async putClient(record: ClientRecord): Promise<void> {
    await this.init();
    await writeJson(this.path('clients', record.client_id), record);
  }

  async getClient(clientId: string): Promise<ClientRecord | undefined> {
    await this.init();
    if (!SAFE_ID.test(clientId)) return undefined;
    return readJson<ClientRecord>(this.path('clients', clientId));
  }

  async putCode(code: string, record: CodeRecord): Promise<void> {
    await this.init();
    await writeJson(this.path('codes', secretHash(code)), record);
  }

  /** Consume a code. Returns it at most once, even with concurrent callers. */
  async takeCode(code: string): Promise<CodeRecord | undefined> {
    await this.init();
    return this.take<CodeRecord>('codes', secretHash(code));
  }

  async putToken(token: string, record: TokenRecord): Promise<void> {
    await this.init();
    await writeJson(this.path('tokens', secretHash(token)), record);
  }

  async getToken(token: string): Promise<TokenRecord | undefined> {
    await this.init();
    return readJson<TokenRecord>(this.path('tokens', secretHash(token)));
  }

  /** Consume a refresh token, so rotation cannot hand out two successors. */
  async takeToken(token: string): Promise<TokenRecord | undefined> {
    await this.init();
    return this.take<TokenRecord>('tokens', secretHash(token));
  }

  private async take<T>(kind: 'codes' | 'tokens', name: string): Promise<T | undefined> {
    const path = this.path(kind, name);
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) return undefined;
    // The unlink is the claim: exactly one caller can remove a given file, so a
    // replayed code (or a rotated refresh token) is refused even across processes.
    try {
      await unlink(path);
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * Delete expired codes and tokens. Called opportunistically when tokens are
   * issued, at most once every few minutes: expiry is enforced on read, so this
   * only keeps the directory from growing without bound.
   */
  async sweepExpired(now = Date.now()): Promise<void> {
    if (now - this.sweptAt < SWEEP_INTERVAL_MS) return;
    this.sweptAt = now;
    await this.init();
    const cutoff = now / 1000;
    for (const kind of ['codes', 'tokens'] as const) {
      const dir = join(this.dir, kind);
      const names = await readdir(dir).catch(() => [] as string[]);
      await Promise.all(
        names.map(async (name) => {
          if (!name.endsWith('.json')) return;
          const record = await readJson<{ expiresAt?: number }>(join(dir, name));
          if (record && typeof record.expiresAt === 'number' && record.expiresAt < cutoff) {
            await unlink(join(dir, name)).catch(() => undefined);
          }
        }),
      );
    }
  }
}

/** Write via a temp file in the same directory, then rename: a reader never sees a partial file. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
