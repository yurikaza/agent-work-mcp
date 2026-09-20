import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorizationServer, AuthStore } from '../src/auth/index.js';
import { startHttpServer } from '../src/http.js';

const SECRET = 'test-secret-do-not-use';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let stateDir: string;
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'agent-work-oauth-'));
  const started = startHttpServer({ port: 0, host: '127.0.0.1', stateDir, token: SECRET, log: () => {} });
  const { port } = await started.listening;
  base = `http://127.0.0.1:${port}`;
  close = started.close;
});

afterAll(async () => {
  await close();
  await rm(stateDir, { recursive: true, force: true });
});

function verifier(): string {
  return randomBytes(32).toString('base64url');
}

function challenge(v: string): string {
  return createHash('sha256').update(v).digest('base64url');
}

async function register(metadata: Record<string, unknown> = {}): Promise<{ client_id: string }> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test connector', ...metadata }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string };
}

/** Pull the hidden fields back out of the form, so the test posts what a browser would. */
function formFields(html: string): URLSearchParams {
  const params = new URLSearchParams();
  for (const [, name, value] of html.matchAll(
    /<input type="hidden" name="([^"]*)" value="([^"]*)"\s*>/g,
  ) as Iterable<RegExpMatchArray>) {
    params.set(name as string, decodeEntities(value as string));
  }
  return params;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Walk registration → authorize → token, the way a connector does. */
async function authorizeAndExchange(secret = SECRET): Promise<Record<string, string>> {
  const { client_id } = await register();
  const v = verifier();
  const query = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge(v),
    code_challenge_method: 'S256',
    scope: 'mcp',
    state: 'xyz',
  });
  const form = await fetch(`${base}/authorize?${query.toString()}`);
  expect(form.status).toBe(200);
  const fields = formFields(await form.text());
  fields.set('secret', secret);

  const granted = await fetch(`${base}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: fields.toString(),
    redirect: 'manual',
  });
  expect(granted.status).toBe(302);
  const location = new URL(granted.headers.get('location') ?? '');
  expect(location.searchParams.get('state')).toBe('xyz');
  const code = location.searchParams.get('code') ?? '';

  const tokens = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: v,
      client_id,
      redirect_uri: REDIRECT,
    }).toString(),
  });
  expect(tokens.status).toBe(200);
  return { ...((await tokens.json()) as Record<string, string>), client_id, code, code_verifier: v };
}

describe('discovery metadata', () => {
  it('serves protected resource metadata at the RFC 9728 path', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ['mcp'],
      resource_name: 'agent-work-mcp',
    });
  });

  it('also answers the bare protected-resource path clients probe', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { resource: string }).toMatchObject({ resource: `${base}/mcp` });
  });

  it('advertises an authorization server that requires PKCE S256', async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('allows the browser to read discovery documents', async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('dynamic client registration', () => {
  it('issues a public client id', async () => {
    const client = (await register()) as Record<string, unknown>;
    expect(typeof client.client_id).toBe('string');
    expect(client.client_secret).toBeUndefined();
    expect(client.token_endpoint_auth_method).toBe('none');
    expect(client.redirect_uris).toEqual([REDIRECT]);
  });

  it('refuses metadata without redirect_uris', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'No redirect' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('refuses a non-https redirect that is not loopback', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('accepts a loopback redirect for native clients', async () => {
    await register({ redirect_uris: ['http://127.0.0.1:33418/callback'] });
  });

  it('answers a CORS preflight', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('authorization endpoint', () => {
  it('refuses an unknown client without redirecting', async () => {
    const res = await fetch(
      `${base}/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('refuses a redirect_uri the client did not register', async () => {
    const { client_id } = await register();
    const res = await fetch(
      `${base}/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects a recoverable error back to the client', async () => {
    const { client_id } = await register();
    const query = new URLSearchParams({
      response_type: 'token',
      client_id,
      redirect_uri: REDIRECT,
      state: 'abc',
    });
    const res = await fetch(`${base}/authorize?${query.toString()}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    expect(location.searchParams.get('state')).toBe('abc');
  });

  it('requires PKCE S256', async () => {
    const { client_id } = await register();
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT });
    const res = await fetch(`${base}/authorize?${query.toString()}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_request');
  });

  it('does not issue a code for the wrong secret', async () => {
    const { client_id } = await register();
    const v = verifier();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge(v),
      code_challenge_method: 'S256',
    });
    const form = await fetch(`${base}/authorize?${query.toString()}`);
    const fields = formFields(await form.text());
    fields.set('secret', 'wrong');
    const res = await fetch(`${base}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('not correct');
  });
});

describe('token endpoint', () => {
  it('completes the PKCE flow', async () => {
    const tokens = await authorizeAndExchange();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope).toBe('mcp');
    expect(typeof tokens.access_token).toBe('string');
    expect(typeof tokens.refresh_token).toBe('string');
    expect(Number(tokens.expires_in)).toBe(3600);
  });

  it('refuses a code replay', async () => {
    const tokens = await authorizeAndExchange();
    const res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: tokens.code ?? '',
        code_verifier: tokens.code_verifier ?? '',
        client_id: tokens.client_id ?? '',
        redirect_uri: REDIRECT,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a mismatched code_verifier', async () => {
    const { client_id } = await register();
    const v = verifier();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge(v),
      code_challenge_method: 'S256',
    });
    const form = await fetch(`${base}/authorize?${query.toString()}`);
    const fields = formFields(await form.text());
    fields.set('secret', SECRET);
    const granted = await fetch(`${base}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields.toString(),
      redirect: 'manual',
    });
    const code = new URL(granted.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier(),
        client_id,
        redirect_uri: REDIRECT,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_grant' });
  });

  it('rotates refresh tokens and refuses the spent one', async () => {
    const tokens = await authorizeAndExchange();
    const body = (refresh: string) =>
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: tokens.client_id ?? '' });

    const first = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body(tokens.refresh_token ?? '').toString(),
    });
    expect(first.status).toBe(200);
    const rotated = (await first.json()) as Record<string, string>;
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    const replay = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body(tokens.refresh_token ?? '').toString(),
    });
    expect(replay.status).toBe(400);
  });

  it('refuses an unsupported grant type', async () => {
    const res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password' }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'unsupported_grant_type' });
  });
});

describe('the MCP endpoint as a resource server', () => {
  it('serves the tools to a token issued by the flow', async () => {
    const tokens = await authorizeAndExchange();
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      authProvider: { token: async () => tokens.access_token ?? '' },
    });
    const client = new Client({ name: 'oauth-smoke', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(16);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('points an unauthenticated caller at the resource metadata', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('still accepts the static server token', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: '{}',
    });
    expect(res.status).not.toBe(401);
  });
});

describe('token lifetime', () => {
  it('stops accepting an access token once it expires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-work-oauth-unit-'));
    try {
      let now = Date.parse('2026-09-20T23:30:00.000Z');
      const auth = new AuthorizationServer({
        store: new AuthStore(join(dir, 'auth')),
        secret: SECRET,
        accessTokenTtlSeconds: 60,
        now: () => now,
      });
      const client = await auth.registerClient({ redirect_uris: [REDIRECT] });
      const v = verifier();
      const code = await auth.issueCode({
        clientId: client.client_id,
        redirectUri: REDIRECT,
        scope: 'mcp',
        codeChallenge: challenge(v),
      });
      const tokens = await auth.exchange(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: v,
          client_id: client.client_id,
          redirect_uri: REDIRECT,
        }),
      );

      const info = await auth.verifyAccessToken(tokens.access_token);
      expect(info.clientId).toBe(client.client_id);
      expect(info.scopes).toEqual(['mcp']);

      now += 61_000;
      await expect(auth.verifyAccessToken(tokens.access_token)).rejects.toThrow(/expired/);
      // The static secret has no stored expiry, so it keeps working.
      expect((await auth.verifyAccessToken(SECRET)).clientId).toBe('static-token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('expires an unused authorization code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-work-oauth-unit-'));
    try {
      let now = Date.parse('2026-09-20T23:30:00.000Z');
      const auth = new AuthorizationServer({
        store: new AuthStore(join(dir, 'auth')),
        secret: SECRET,
        codeTtlSeconds: 30,
        now: () => now,
      });
      const client = await auth.registerClient({ redirect_uris: [REDIRECT] });
      const v = verifier();
      const code = await auth.issueCode({
        clientId: client.client_id,
        redirectUri: REDIRECT,
        scope: 'mcp',
        codeChallenge: challenge(v),
      });
      now += 31_000;
      await expect(
        auth.exchange(
          new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: v,
            client_id: client.client_id,
            redirect_uri: REDIRECT,
          }),
        ),
      ).rejects.toThrow(/expired/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
