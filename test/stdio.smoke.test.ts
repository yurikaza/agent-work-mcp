import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
let project: string;

beforeAll(() => {
  // Exercise the real published entry point, not the sources.
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'ignore' });
}, 120_000);

afterAll(async () => {
  if (project) await rm(project, { recursive: true, force: true });
});

describe('stdio binary', () => {
  it('serves the tools over stdio and persists state in the project', async () => {
    project = await mkdtemp(join(tmpdir(), 'agent-work-stdio-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'dist', 'cli.js')],
      cwd: project,
      env: { PATH: process.env.PATH ?? '' },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(16);
      const started = await client.callTool({
        name: 'start_session',
        arguments: { mode: 'desk', goal: 'smoke test' },
      });
      expect(started.isError).toBeFalsy();
      const sessionId = (started.structuredContent as { session: { sessionId: string } }).session.sessionId;
      expect(await readdir(join(project, '.agent-work', 'sessions'))).toEqual([sessionId]);
      expect(await readdir(join(project, '.agent-work', 'sessions', sessionId))).toEqual(['1.json']);
    } finally {
      await client.close();
    }
  }, 60_000);
});
