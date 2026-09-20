#!/usr/bin/env node
/**
 * HTTP entry point (Streamable HTTP, MCP spec 2026-07-28) for hosted use —
 * Railway, a VPS, or any long-lived Node process. The stdio entry point in
 * `cli.ts` is unchanged and remains the local default.
 *
 * Differences from the stdio server, on purpose:
 *  - No project inspector. A hosted server has no clone of the project; the
 *    agent passes `projectContext` to `update_work_graph` instead.
 *  - Bearer-token auth. `AGENT_WORK_TOKEN` must be set unless
 *    `AGENT_WORK_ALLOW_UNAUTHENTICATED=1` is given explicitly.
 *  - State lives wherever `AGENT_WORK_STATE_DIR` points (a mounted volume in
 *    production). Sessions from every project share one store; `projectRoot`
 *    is a label, not a path the server reads.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { FileSessionRepository } from './adapters/persistence/file-repository.js';
import { Orchestrator } from './core/orchestrator.js';
import { createMcpServer } from './mcp/server.js';
import { VERSION } from './version.js';

export interface HttpServerOptions {
  port: number;
  host?: string;
  stateDir: string;
  /** Bearer token required on `/mcp`. `undefined` only with `allowUnauthenticated`. */
  token?: string;
  allowUnauthenticated?: boolean;
  /** Label used as `projectRoot` for sessions that do not name one. */
  defaultProjectRoot?: string;
  log?: (line: string) => void;
}

const MCP_PATH = '/mcp';

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const [scheme, value] = h.split(' ', 2);
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startHttpServer(opts: HttpServerOptions) {
  if (!opts.token && !opts.allowUnauthenticated) {
    throw new Error('AGENT_WORK_TOKEN is required (or set AGENT_WORK_ALLOW_UNAUTHENTICATED=1 explicitly)');
  }
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const orchestrator = new Orchestrator({
    repository: new FileSessionRepository(opts.stateDir),
    defaultProjectRoot: opts.defaultProjectRoot ?? opts.stateDir,
  });
  const handler = createMcpHandler(() => createMcpServer(orchestrator));
  const mcp = toNodeHandler(handler, { onerror: (e) => log(`agent-work-mcp: ${e.message}`) });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      json(res, 200, { ok: true, name: 'agent-work-mcp', version: VERSION });
      return;
    }
    if (url.pathname !== MCP_PATH) {
      json(res, 404, { error: 'not found' });
      return;
    }
    if (opts.token) {
      const presented = bearer(req);
      if (!presented || !constantTimeEqual(presented, opts.token)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    void mcp(req, res);
  });

  const listening = new Promise<{ port: number }>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      log(`agent-work-mcp ${VERSION} · http://${opts.host ?? '0.0.0.0'}:${port}${MCP_PATH} · state: ${opts.stateDir}`);
      resolveListening({ port });
    });
  });

  const close = async () => {
    await handler.close();
    await new Promise<void>((r) => server.close(() => r()));
  };

  return { server, listening, close };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const stateDir = resolve(process.env.AGENT_WORK_STATE_DIR ?? '.agent-work');
  const { listening, close } = startHttpServer({
    port,
    stateDir,
    token: process.env.AGENT_WORK_TOKEN || undefined,
    allowUnauthenticated: process.env.AGENT_WORK_ALLOW_UNAUTHENTICATED === '1',
    defaultProjectRoot: process.env.AGENT_WORK_PROJECT_ROOT,
  });
  void listening;
  const shutdown = () => {
    void close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
