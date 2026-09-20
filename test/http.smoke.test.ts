import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/http.js';

const TOKEN = 'test-token-do-not-use';
let stateDir: string;
let port: number;
let close: () => Promise<void>;

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'agent-work-http-'));
  const started = startHttpServer({ port: 0, host: '127.0.0.1', stateDir, token: TOKEN, log: () => {} });
  ({ port } = await started.listening);
  close = started.close;
});

afterAll(async () => {
  await close();
  await rm(stateDir, { recursive: true, force: true });
});

describe('http server', () => {
  it('answers /healthz without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: 'agent-work-mcp' });
  });

  it('rejects /mcp without a bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('serves the tools over Streamable HTTP and persists state', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => TOKEN },
    });
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(16);
      const started = await client.callTool({
        name: 'start_session',
        arguments: { mode: 'desk', goal: 'http smoke test', projectRoot: 'https://github.com/example/repo' },
      });
      expect(started.isError).toBeFalsy();
      const sessionId = (started.structuredContent as { session: { sessionId: string } }).session.sessionId;
      expect(await readdir(join(stateDir, 'sessions'))).toEqual([sessionId]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('refuses to start without a token unless explicitly allowed', () => {
    expect(() => startHttpServer({ port: 0, stateDir, log: () => {} })).toThrow(/AGENT_WORK_TOKEN/);
  });
});
