// Mandor provider: an OpenAI-compatible chat completions API reached with a Mandor token.
// The token comes from a Google sign-in hosted by Mandor, using OAuth 2.0 PKCE over a loopback
// redirect, so the app never sees Google credentials. The token stays in the main process and is
// encrypted with safeStorage, exactly like the SSH secrets in store.js.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, shell, safeStorage } = require('electron');

const MANDOR = 'https://mandor-web.kordon-kircon.workers.dev';
const CLIENT_NAME = 'Server Explorer';
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const MODEL = 'mandor/auto';

const tokenFile = () => path.join(app.getPath('userData'), 'mandor-token.json');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- Token storage ----------

function saveToken(token) {
  const text = JSON.stringify(token);
  const stored = safeStorage.isEncryptionAvailable()
    ? { enc: true, data: safeStorage.encryptString(text).toString('base64') }
    : { enc: false, data: Buffer.from(text, 'utf8').toString('base64') };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(stored), { mode: 0o600 });
}

function loadToken() {
  try {
    const stored = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
    const buf = Buffer.from(stored.data, 'base64');
    return JSON.parse(stored.enc ? safeStorage.decryptString(buf) : buf.toString('utf8'));
  } catch {
    return null;
  }
}

function clearToken() {
  try {
    fs.unlinkSync(tokenFile());
  } catch {
    // Already gone.
  }
}

// ---------- Sign-in ----------

const CALLBACK_MESSAGES = {
  access_pending: 'Your Mandor account is waiting for approval. Ask the Mandor admin to tick "Model API" for it, then connect again.',
  access_denied: 'Connecting to Mandor was cancelled.',
};

// The browser page is built here, so anything coming from the network is escaped first.
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const pageHtml = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  '<body style="font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;padding:48px;text-align:center">' +
  `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p><p>You can close this tab.</p></body>`;

// Opens the system browser, waits for the loopback callback, and exchanges the code for a token.
function connect() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));

  return new Promise((resolve, reject) => {
    let redirectUri = null;
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(value);
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      // A callback with the wrong state isn't ours: answer it and keep waiting.
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('State mismatch.');
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        const message = CALLBACK_MESSAGES[error] || `Mandor returned an error: ${error}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(pageHtml('Not connected', message));
        finish(Object.assign(new Error(message), { code: error }));
        return;
      }
      try {
        const r = await fetch(`${MANDOR}/v1/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: url.searchParams.get('code'),
            code_verifier: verifier,
            redirect_uri: redirectUri,
          }),
          signal: AbortSignal.timeout(30000),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error?.message || `Mandor returned ${r.status}`);
        saveToken({ token: body.access_token, email: body.email, expiresAt: body.expires_at });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(pageHtml('Connected to Mandor', `Signed in as ${body.email}.`));
        finish(null, { email: body.email, expiresAt: body.expires_at });
      } catch (err) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(pageHtml('Not connected', err.message));
        finish(err);
      }
    });

    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for the Mandor sign-in. If your account is new, it may still be waiting for admin approval.')),
      CONNECT_TIMEOUT_MS
    );

    server.on('error', (err) => finish(err));
    // Port 0 picks a free port; binding to 127.0.0.1 keeps the callback off the network.
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const query = new URLSearchParams({
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        client_name: CLIENT_NAME,
      });
      shell.openExternal(`${MANDOR}/connect?${query}`);
    });
  });
}

// ---------- API ----------

async function mandorFetch(pathname, init = {}) {
  const saved = loadToken();
  if (!saved) throw new Error('Not connected to Mandor.');
  return fetch(`${MANDOR}${pathname}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${saved.token}` },
    signal: AbortSignal.timeout(20000),
  });
}

// Turns a failed Mandor response into a sentence the user can act on (see §4.2 of public-api.md).
// A 401 token can never work again, so it is thrown away; a 403 token is kept.
function mapError(status, body) {
  let code = '';
  let message = '';
  try {
    const json = JSON.parse(body);
    code = json.error?.code || '';
    message = json.error?.message || '';
  } catch {
    // Not JSON: fall back to the status.
  }
  if (status === 401) {
    clearToken();
    return 'Your Mandor sign-in is no longer valid. Connect to Mandor again in the AI settings.';
  }
  if (status === 403) return 'Your Mandor access was withdrawn. Ask the Mandor admin to tick "Model API" for your account.';
  if (status === 429) return 'The daily Mandor limit is used up. It resets at 00:00 UTC (07:00 in Jakarta).';
  if (status === 413) return 'That message was too large for Mandor. Start a new chat, or work with smaller files.';
  if (status === 502) return "Mandor's free models are all busy right now. Try again in a moment.";
  if (status === 503) {
    return code === 'no_providers'
      ? 'Mandor has no model providers configured. Ask the Mandor admin to set them up.'
      : 'Mandor could not check your access just now. Try again in a few seconds.';
  }
  return message || `Mandor returned ${status}`;
}

// { connected } plus the quota, so the settings screen can show what is left.
async function status() {
  if (!loadToken()) return { connected: false };
  let res;
  try {
    res = await mandorFetch('/v1/me');
  } catch (err) {
    return { connected: false, error: `Can't reach Mandor. (${err.cause?.code || err.message})` };
  }
  const text = await res.text();
  if (!res.ok) return { connected: false, error: mapError(res.status, text) };
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Keep the defaults below.
  }
  return {
    connected: true,
    email: body.email || '',
    dailyCap: body.daily_cap ?? null,
    usedToday: body.used_today ?? 0,
    resetsAt: body.resets_at || '',
    expiresAt: body.token_expires_at || '',
  };
}

async function disconnect() {
  try {
    await mandorFetch('/v1/token/revoke', { method: 'POST' });
  } catch {
    // Revoking is best effort; the local token goes either way.
  }
  clearToken();
}

// What the OpenAI-compatible provider needs, or null when nobody is signed in.
function providerSettings() {
  const saved = loadToken();
  return saved ? { baseUrl: `${MANDOR}/v1`, apiKey: saved.token, model: MODEL, email: saved.email } : null;
}

module.exports = { connect, status, disconnect, providerSettings, mapError };
