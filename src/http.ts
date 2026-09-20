#!/usr/bin/env node
/**
 * HTTP entry point (Streamable HTTP, MCP spec 2026-07-28) for hosted use —
 * Railway, a VPS, or any long-lived Node process. The stdio entry point in
 * `cli.ts` is unchanged and remains the local default.
 *
 * Differences from the stdio server, on purpose:
 *  - No project inspector. A hosted server has no clone of the project; the
 *    agent passes `projectContext` to `update_work_graph` instead.
 *  - Authentication. `AGENT_WORK_TOKEN` must be set unless
 *    `AGENT_WORK_ALLOW_UNAUTHENTICATED=1` is given explicitly. The token is
 *    accepted directly as a bearer, and is also the secret that authorizes an
 *    OAuth flow (see `auth/`), which is how claude.ai custom connectors attach.
 *  - State lives wherever `AGENT_WORK_STATE_DIR` points (a mounted volume in
 *    production). Sessions from every project share one store; `projectRoot`
 *    is a label, not a path the server reads.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import { FileSessionRepository } from './adapters/persistence/file-repository.js';
import { AuthorizationServer, AuthStore, createAuthRoutes } from './auth/index.js';
import { Orchestrator } from './core/orchestrator.js';
import { createMcpServer } from './mcp/server.js';
import { VERSION } from './version.js';

export interface HttpServerOptions {
  port: number;
  host?: string;
  stateDir: string;
  /** Bearer token required on `/mcp`, and the secret that authorizes OAuth. `undefined` only with `allowUnauthenticated`. */
  token?: string;
  allowUnauthenticated?: boolean;
  /** Absolute public origin, e.g. `https://agent-work-mcp.up.railway.app`. Derived per request when unset. */
  publicUrl?: string;
  /** Label used as `projectRoot` for sessions that do not name one. */
  defaultProjectRoot?: string;
  log?: (line: string) => void;
}

const MCP_PATH = '/mcp';

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

  // Without a token there is nothing to authorize against, so the OAuth routes
  // are simply absent in `allowUnauthenticated` mode rather than open.
  const auth = opts.token
    ? createAuthRoutes({
        auth: new AuthorizationServer({ store: new AuthStore(join(opts.stateDir, 'auth')), secret: opts.token }),
        publicUrl: opts.publicUrl,
        mcpPath: MCP_PATH,
      })
    : undefined;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        json(res, 200, { ok: true, name: 'agent-work-mcp', version: VERSION });
        return;
      }
      if (auth && (await auth.handle(req, res))) return;
      if (url.pathname !== MCP_PATH) {
        json(res, 404, { error: 'not found' });
        return;
      }
      if (auth) {
        const authInfo = await auth.guard(req, res);
        if (!authInfo) return; // A challenge has already been sent.
        (req as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
      }
      await mcp(req, res);
    })().catch((e: unknown) => {
      log(`agent-work-mcp: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
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
    publicUrl: process.env.AGENT_WORK_PUBLIC_URL || undefined,
    defaultProjectRoot: process.env.AGENT_WORK_PROJECT_ROOT,
  });
  void listening;
  const shutdown = () => {
    void close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
