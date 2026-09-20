import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AuthInfo,
  type OAuthMetadata,
  OAuthError,
  OAuthErrorCode,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import { authorizeForm, errorPage } from './form.js';
import { type AuthorizationServer, MCP_SCOPE } from './server.js';

/**
 * The HTTP surface of the authorization server, wired for `node:http` so it can
 * live in the same process — and on the same port — as the MCP endpoint it
 * protects. A connector discovers everything it needs from
 * `/.well-known/oauth-protected-resource`, registers itself, and comes back
 * with a token; no second deployment, no external identity provider.
 *
 * Public identifiers (issuer, resource) are derived from each request unless
 * `AGENT_WORK_PUBLIC_URL` pins them, so the same build serves
 * `http://127.0.0.1:<port>` in tests and `https://<app>.up.railway.app` behind
 * Railway's proxy.
 */

const MAX_BODY_BYTES = 64 * 1024;
const PRM_PATH = '/.well-known/oauth-protected-resource';
const ASM_PATH = '/.well-known/oauth-authorization-server';

export interface AuthRoutesOptions {
  auth: AuthorizationServer;
  /** Absolute public origin of this server. Derived from the request when unset. */
  publicUrl?: string;
  /** Path the MCP endpoint is served on; it is the OAuth "resource" identifier. */
  mcpPath: string;
}

export interface AuthRoutes {
  /** Answer an OAuth route. Returns false when the path belongs to someone else. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Gate the MCP endpoint. Returns the token's `AuthInfo`, or `undefined` once a challenge has been sent. */
  guard(req: IncomingMessage, res: ServerResponse): Promise<AuthInfo | undefined>;
}

export function createAuthRoutes(opts: AuthRoutesOptions): AuthRoutes {
  const { auth, mcpPath } = opts;

  const originOf = (req: IncomingMessage): URL => {
    if (opts.publicUrl) return new URL(opts.publicUrl);
    const proto = firstHeader(req, 'x-forwarded-proto') ?? 'http';
    const host = firstHeader(req, 'x-forwarded-host') ?? req.headers.host ?? 'localhost';
    return new URL(`${proto}://${host}`);
  };

  const metadataOptions = (origin: URL) => ({
    oauthMetadata: authorizationServerMetadata(origin),
    resourceServerUrl: new URL(mcpPath, origin),
    scopesSupported: [MCP_SCOPE],
    resourceName: 'agent-work-mcp',
  });

  return {
    async handle(req, res) {
      const origin = originOf(req);
      const url = new URL(req.url ?? '/', origin);
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;

      if (path === PRM_PATH || path.startsWith(`${PRM_PATH}/`) || path === ASM_PATH || path.startsWith(`${ASM_PATH}/`)) {
        // RFC 9728 puts the resource path after the well-known segment; answer the
        // bare form too, since clients probe both.
        const canonical = path.startsWith(PRM_PATH)
          ? new URL(getOAuthProtectedResourceMetadataUrl(new URL(mcpPath, origin)))
          : new URL(ASM_PATH, origin);
        const response = oauthMetadataResponse(webRequest(req, canonical), metadataOptions(origin));
        if (response) {
          await sendWeb(res, response);
          return true;
        }
      }

      if (path === '/register') return handleRegister(auth, req, res);
      if (path === '/authorize') return handleAuthorize(auth, req, res, url);
      if (path === '/token') return handleToken(auth, req, res);
      return false;
    },

    async guard(req, res) {
      const origin = originOf(req);
      const gate = requireBearerAuth({
        verifier: auth,
        requiredScopes: [MCP_SCOPE],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(mcpPath, origin)),
      });
      const result = await gate(webRequest(req, new URL(req.url ?? mcpPath, origin)));
      if (result instanceof Response) {
        await sendWeb(res, result);
        return undefined;
      }
      return result;
    },
  };
}

/** RFC 8414 metadata for this server, acting as its own authorization server. */
export function authorizationServerMetadata(origin: URL): OAuthMetadata {
  return {
    issuer: origin.origin,
    authorization_endpoint: new URL('/authorize', origin).href,
    token_endpoint: new URL('/token', origin).href,
    registration_endpoint: new URL('/register', origin).href,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  };
}

// --- Endpoints -------------------------------------------------------------

async function handleRegister(auth: AuthorizationServer, req: IncomingMessage, res: ServerResponse): Promise<true> {
  if (preflight(req, res, 'POST, OPTIONS')) return true;
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST, OPTIONS');
  try {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, 'Body must be JSON.');
    }
    const client = await auth.registerClient(parsed);
    sendJson(res, 201, client, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  } catch (e) {
    sendOAuthError(res, e);
  }
  return true;
}

async function handleAuthorize(
  auth: AuthorizationServer,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<true> {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');

  let params: URLSearchParams;
  try {
    params = req.method === 'GET' ? url.searchParams : new URLSearchParams(await readBody(req));
  } catch (e) {
    sendOAuthError(res, e);
    return true;
  }

  const outcome = await auth.authorizationRequest(params);
  if (!outcome.ok) {
    if (outcome.redirect) {
      // The redirect URI is registered, so the client gets to see its own error.
      const target = new URL(outcome.redirect.uri);
      target.searchParams.set('error', String(outcome.error.code));
      target.searchParams.set('error_description', outcome.error.message);
      if (outcome.redirect.state !== undefined) target.searchParams.set('state', outcome.redirect.state);
      res.writeHead(302, { location: target.href, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    sendHtml(res, 400, errorPage('Cannot authorize', outcome.error.message));
    return true;
  }

  if (req.method === 'GET') {
    sendHtml(res, 200, authorizeForm({ request: outcome.request }));
    return true;
  }

  const secret = params.get('secret') ?? '';
  if (!auth.checkSecret(secret)) {
    sendHtml(res, 401, authorizeForm({ request: outcome.request, error: 'That secret is not correct.' }));
    return true;
  }

  const code = await auth.issueCode(outcome.request);
  const target = new URL(outcome.request.redirectUri);
  target.searchParams.set('code', code);
  if (outcome.request.state !== undefined) target.searchParams.set('state', outcome.request.state);
  res.writeHead(302, { location: target.href, 'cache-control': 'no-store' });
  res.end();
  return true;
}

async function handleToken(auth: AuthorizationServer, req: IncomingMessage, res: ServerResponse): Promise<true> {
  if (preflight(req, res, 'POST, OPTIONS')) return true;
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST, OPTIONS');
  try {
    const tokens = await auth.exchange(new URLSearchParams(await readBody(req)));
    sendJson(res, 200, tokens, { 'access-control-allow-origin': '*', 'cache-control': 'no-store', pragma: 'no-cache' });
  } catch (e) {
    sendOAuthError(res, e);
  }
  return true;
}

// --- Plumbing --------------------------------------------------------------

/**
 * A header-only web `Request` for the SDK helpers, which read the method,
 * the URL and a few headers and never the body. Building one here keeps the
 * real request body untouched for the MCP handler downstream.
 */
function webRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const name of ['authorization', 'origin', 'access-control-request-method', 'access-control-request-headers']) {
    const value = firstHeader(req, name);
    if (value !== undefined) headers.set(name, value);
  }
  return new Request(url, { method: req.method ?? 'GET', headers });
}

async function sendWeb(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
  res.writeHead(response.status, headers);
  res.end(body);
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(',')[0]?.trim() || undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Request body is too large.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function preflight(req: IncomingMessage, res: ServerResponse, allow: string): boolean {
  if (req.method !== 'OPTIONS') return false;
  const requested = firstHeader(req, 'access-control-request-headers');
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': allow,
    ...(requested ? { 'access-control-allow-headers': requested, vary: 'Access-Control-Request-Headers' } : {}),
  });
  res.end();
  return true;
}

function methodNotAllowed(res: ServerResponse, allow: string): true {
  const error = new OAuthError(OAuthErrorCode.MethodNotAllowed, 'Method not allowed for this endpoint.');
  sendJson(res, 405, error.toResponseObject(), { allow, 'access-control-allow-origin': '*' });
  return true;
}

function sendOAuthError(res: ServerResponse, e: unknown): void {
  const error =
    e instanceof OAuthError ? e : new OAuthError(OAuthErrorCode.ServerError, 'The authorization server failed.');
  sendJson(res, statusFor(error), error.toResponseObject(), {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
}

function statusFor(error: OAuthError): number {
  switch (error.code) {
    case OAuthErrorCode.InvalidClient:
      return 401;
    case OAuthErrorCode.MethodNotAllowed:
      return 405;
    case OAuthErrorCode.ServerError:
      return 500;
    default:
      return 400;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}
