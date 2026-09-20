import { createHash, timingSafeEqual } from 'node:crypto';
import { type AuthInfo, OAuthError, OAuthErrorCode, type OAuthTokens } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type ClientRecord, AuthStore, newSecret } from './store.js';

/**
 * A single-operator OAuth 2.1 authorization server, colocated with the MCP
 * resource server it protects.
 *
 * It exists for one reason: claude.ai custom connectors speak OAuth and will
 * not carry a static bearer token. So the hosted server both *is* the resource
 * server and runs the smallest authorization server that satisfies the MCP
 * authorization spec — dynamic client registration (RFC 7591), authorization
 * code with mandatory PKCE S256 (RFC 7636), refresh tokens with rotation.
 *
 * "Who is the resource owner?" has one answer: whoever knows the server secret
 * (`AGENT_WORK_TOKEN`). The `/authorize` form asks for exactly that, and the
 * same secret still works as a static bearer for tests, curl and local use. One
 * secret, two ways in; no user database, no identity provider.
 */

export const MCP_SCOPE = 'mcp';

const DEFAULT_ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_CODE_TTL_SECONDS = 60;

/** RFC 7636 §4.1. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface AuthorizationServerOptions {
  store: AuthStore;
  /** The operator secret: typed into the `/authorize` form, and accepted as a static bearer. */
  secret: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  codeTtlSeconds?: number;
  now?: () => number;
}

/** A validated `/authorize` request, ready to be granted. */
export interface AuthorizeRequest {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  state?: string;
  scope: string;
  codeChallenge: string;
  resource?: string;
}

/**
 * The outcome of validating an `/authorize` request. An invalid `client_id` or
 * `redirect_uri` must never be redirected to — that would make the server an
 * open redirector — so those are reported to the browser instead. Everything
 * else goes back to the client as an OAuth error on the redirect URI.
 */
export type AuthorizeOutcome =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; error: OAuthError; redirect?: { uri: string; state?: string } };

const ClientMetadataSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().max(200).optional(),
  scope: z.string().max(200).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

export class AuthorizationServer {
  private readonly store: AuthStore;
  private readonly secretDigest: Buffer;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly codeTtl: number;
  private readonly now: () => number;

  constructor(opts: AuthorizationServerOptions) {
    this.store = opts.store;
    this.secretDigest = sha256(opts.secret);
    this.accessTtl = opts.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS;
    this.refreshTtl = opts.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
    this.codeTtl = opts.codeTtlSeconds ?? DEFAULT_CODE_TTL_SECONDS;
    this.now = opts.now ?? Date.now;
  }

  private seconds(): number {
    return Math.floor(this.now() / 1000);
  }

  /** Compare a presented secret without leaking its length or prefix through timing. */
  checkSecret(presented: string): boolean {
    return timingSafeEqual(sha256(presented), this.secretDigest);
  }

  // --- Dynamic client registration (RFC 7591) ------------------------------

  /**
   * Register a client. Every client is public: no secret is issued, because
   * PKCE is what binds the token exchange to whoever started the flow, and a
   * secret shipped to a connector would not be one.
   */
  async registerClient(body: unknown): Promise<ClientRecord> {
    const parsed = ClientMetadataSchema.safeParse(body);
    if (!parsed.success) {
      throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, 'Invalid client metadata: redirect_uris is required.');
    }
    const redirectUris = parsed.data.redirect_uris.map(normalizeRedirectUri);
    const grantTypes = parsed.data.grant_types ?? ['authorization_code', 'refresh_token'];
    for (const grant of grantTypes) {
      if (grant !== 'authorization_code' && grant !== 'refresh_token') {
        throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, `Unsupported grant_type '${grant}'.`);
      }
    }
    const responseTypes = parsed.data.response_types ?? ['code'];
    for (const type of responseTypes) {
      if (type !== 'code') {
        throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, `Unsupported response_type '${type}'.`);
      }
    }
    const record: ClientRecord = {
      client_id: newSecret(),
      client_id_issued_at: this.seconds(),
      redirect_uris: redirectUris,
      client_name: parsed.data.client_name,
      scope: MCP_SCOPE,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: 'none',
    };
    await this.store.putClient(record);
    return record;
  }

  // --- Authorization endpoint ---------------------------------------------

  async authorizationRequest(params: URLSearchParams): Promise<AuthorizeOutcome> {
    const clientId = params.get('client_id') ?? '';
    const client = clientId ? await this.store.getClient(clientId) : undefined;
    if (!client) {
      return { ok: false, error: new OAuthError(OAuthErrorCode.InvalidClient, 'Unknown client_id.') };
    }

    // Exact string match against a registered URI — never a prefix or host match.
    const redirectUri = params.get('redirect_uri');
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return {
        ok: false,
        error: new OAuthError(OAuthErrorCode.InvalidRedirectUri, 'redirect_uri does not match a registered URI.'),
      };
    }

    // From here on the redirect URI is trusted, so errors can travel back to the client.
    const state = params.get('state') ?? undefined;
    const redirect = { uri: redirectUri, state };
    const fail = (code: OAuthErrorCode, message: string): AuthorizeOutcome => ({
      ok: false,
      error: new OAuthError(code, message),
      redirect,
    });

    if (params.get('response_type') !== 'code') {
      return fail(OAuthErrorCode.UnsupportedResponseType, "Only response_type 'code' is supported.");
    }
    if (params.get('code_challenge_method') !== 'S256') {
      return fail(OAuthErrorCode.InvalidRequest, "code_challenge_method must be 'S256'.");
    }
    const codeChallenge = params.get('code_challenge');
    if (!codeChallenge || codeChallenge.length < 43 || codeChallenge.length > 128) {
      return fail(OAuthErrorCode.InvalidRequest, 'A PKCE code_challenge is required.');
    }
    const requested = params.get('scope');
    if (requested && requested.split(/\s+/).some((s) => s && s !== MCP_SCOPE)) {
      return fail(OAuthErrorCode.InvalidScope, `The only scope is '${MCP_SCOPE}'.`);
    }

    return {
      ok: true,
      request: {
        clientId: client.client_id,
        clientName: client.client_name,
        redirectUri,
        state,
        scope: MCP_SCOPE,
        codeChallenge,
        resource: params.get('resource') ?? undefined,
      },
    };
  }

  /** Grant a validated request. Only called once the operator secret has been checked. */
  async issueCode(request: AuthorizeRequest): Promise<string> {
    const code = newSecret();
    await this.store.putCode(code, {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: request.scope,
      resource: request.resource,
      expiresAt: this.seconds() + this.codeTtl,
    });
    return code;
  }

  // --- Token endpoint ------------------------------------------------------

  async exchange(params: URLSearchParams): Promise<OAuthTokens> {
    const grantType = params.get('grant_type');
    if (grantType === 'authorization_code') return this.exchangeCode(params);
    if (grantType === 'refresh_token') return this.exchangeRefreshToken(params);
    throw new OAuthError(OAuthErrorCode.UnsupportedGrantType, `Unsupported grant_type '${grantType ?? ''}'.`);
  }

  private async exchangeCode(params: URLSearchParams): Promise<OAuthTokens> {
    const code = params.get('code');
    const verifier = params.get('code_verifier');
    if (!code) throw new OAuthError(OAuthErrorCode.InvalidRequest, 'code is required.');
    if (!verifier || !VERIFIER.test(verifier)) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, 'A valid PKCE code_verifier is required.');
    }

    const grant = await this.store.takeCode(code);
    if (!grant) throw new OAuthError(OAuthErrorCode.InvalidGrant, 'Unknown, used or expired authorization code.');
    if (grant.expiresAt < this.seconds()) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, 'Unknown, used or expired authorization code.');
    }
    if (params.get('client_id') !== grant.clientId) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, 'client_id does not match the authorization code.');
    }
    const redirectUri = params.get('redirect_uri');
    if (redirectUri !== null && redirectUri !== grant.redirectUri) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, 'redirect_uri does not match the authorization code.');
    }
    // Digest both sides: `timingSafeEqual` throws on a length mismatch, and the
    // stored challenge is client-supplied.
    if (!timingSafeEqual(sha256(s256(verifier)), sha256(grant.codeChallenge))) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, 'code_verifier does not match the code_challenge.');
    }

    return this.issueTokens(grant.clientId, grant.scope, grant.resource);
  }

  private async exchangeRefreshToken(params: URLSearchParams): Promise<OAuthTokens> {
    const presented = params.get('refresh_token');
    if (!presented) throw new OAuthError(OAuthErrorCode.InvalidRequest, 'refresh_token is required.');

    // Rotation: the presented token is consumed whether or not the rest checks
    // out, so a stolen refresh token is worth at most one use.
    const record = await this.store.takeToken(presented);
    if (!record || record.kind !== 'refresh' || record.expiresAt < this.seconds()) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, 'Unknown, used or expired refresh token.');
    }
    const clientId = params.get('client_id');
    if (clientId !== null && clientId !== record.clientId) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, 'client_id does not match the refresh token.');
    }
    return this.issueTokens(record.clientId, record.scope, record.resource);
  }

  private async issueTokens(clientId: string, scope: string, resource?: string): Promise<OAuthTokens> {
    const issuedAt = this.seconds();
    const accessToken = newSecret();
    const refreshToken = newSecret();
    await this.store.putToken(accessToken, {
      kind: 'access',
      clientId,
      scope,
      resource,
      expiresAt: issuedAt + this.accessTtl,
    });
    await this.store.putToken(refreshToken, {
      kind: 'refresh',
      clientId,
      scope,
      resource,
      expiresAt: issuedAt + this.refreshTtl,
    });
    void this.store.sweepExpired(this.now()).catch(() => undefined);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTtl,
      refresh_token: refreshToken,
      scope,
    };
  }

  // --- Resource server side (OAuthTokenVerifier) ---------------------------

  /**
   * Verify a bearer token presented on `/mcp`. Two kinds are accepted: a token
   * this server issued, and the operator secret itself. The static secret has
   * no stored expiry, so it is reported as valid for one access-token lifetime
   * from now — `verifyBearerToken` rejects an `AuthInfo` without `expiresAt`.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.checkSecret(token)) {
      return {
        token,
        clientId: 'static-token',
        scopes: [MCP_SCOPE],
        expiresAt: this.seconds() + this.accessTtl,
      };
    }
    const record = await this.store.getToken(token);
    if (!record || record.kind !== 'access') {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token.');
    }
    if (record.expiresAt < this.seconds()) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token has expired.');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scope.split(' ').filter(Boolean),
      expiresAt: record.expiresAt,
    };
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Accept a redirect URI only if it is one a confidential-free client can hold
 * safely: HTTPS anywhere, or plain HTTP on loopback for a native client's local
 * callback. Anything else — custom schemes, `javascript:`, fragments — is
 * refused at registration rather than at redirect time.
 */
function normalizeRedirectUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidRedirectUri, `redirect_uri is not an absolute URL: ${raw}`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new OAuthError(OAuthErrorCode.InvalidRedirectUri, `redirect_uri must be https (or http on loopback): ${raw}`);
  }
  if (url.hash) throw new OAuthError(OAuthErrorCode.InvalidRedirectUri, `redirect_uri must not have a fragment: ${raw}`);
  return raw;
}
