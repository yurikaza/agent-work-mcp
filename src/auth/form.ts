import type { AuthorizeRequest } from './server.js';

/**
 * The consent step, such as it is. There is one resource owner — the operator —
 * and one credential, the server secret, so the page is a single password field
 * plus the authorization request echoed back in hidden fields. It is rendered
 * server-side with no scripts and no external assets: the form must work in the
 * embedded browser a connector opens.
 */

export interface FormOptions {
  request: AuthorizeRequest;
  /** Shown above the field after a wrong secret. */
  error?: string;
}

export function authorizeForm({ request, error }: FormOptions): string {
  const hidden = [
    ['client_id', request.clientId],
    ['redirect_uri', request.redirectUri],
    ['response_type', 'code'],
    ['code_challenge', request.codeChallenge],
    ['code_challenge_method', 'S256'],
    ['scope', request.scope],
    ['state', request.state],
    ['resource', request.resource],
  ]
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n      ');

  const client = request.clientName ? escapeHtml(request.clientName) : 'An MCP client';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Authorize · agent-work-mcp</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; }
      main { width: min(28rem, 90vw); padding: 2rem 0; }
      h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
      p { margin: .25rem 0 1.25rem; opacity: .8; }
      label { display: block; font-weight: 600; margin-bottom: .35rem; }
      input[type=password] { width: 100%; box-sizing: border-box; padding: .6rem .7rem; font: inherit;
        border: 1px solid currentColor; border-radius: .4rem; background: transparent; color: inherit; }
      button { margin-top: 1rem; width: 100%; padding: .65rem; font: inherit; font-weight: 600;
        border: 0; border-radius: .4rem; cursor: pointer; }
      .error { color: #b3261e; font-weight: 600; margin-bottom: .75rem; }
      .scope { font-size: .875rem; opacity: .7; margin-top: 1.25rem; }
      code { font-family: ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <main>
      <h1>Authorize access</h1>
      <p>${client} is asking to use your agent-work-mcp server.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/authorize">
      ${hidden}
        <label for="secret">Server secret</label>
        <input id="secret" name="secret" type="password" autocomplete="off" autofocus required>
        <button type="submit">Authorize</button>
      </form>
      <p class="scope">Grants the <code>${escapeHtml(request.scope)}</code> scope. The secret is your
      <code>AGENT_WORK_TOKEN</code>; it is checked, never stored by the browser.</p>
    </main>
  </body>
</html>
`;
}

export function errorPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · agent-work-mcp</title>
  <style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;
  place-items:center;min-height:100vh}main{width:min(28rem,90vw)}h1{font-size:1.25rem}</style></head>
  <body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
