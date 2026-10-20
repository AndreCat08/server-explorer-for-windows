// Persistent app data: saved servers and trusted host keys.
// Passwords / key passphrases are encrypted with Electron safeStorage (Windows DPAPI).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUTH_TYPES = ['auto', 'key', 'password'];

function filePath(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function encrypt(text) {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: true, data: safeStorage.encryptString(text).toString('base64') };
  }
  return { enc: false, data: Buffer.from(text, 'utf8').toString('base64') };
}

function decrypt(secret) {
  if (!secret) return undefined;
  const buf = Buffer.from(secret.data, 'base64');
  return secret.enc ? safeStorage.decryptString(buf) : buf.toString('utf8');
}

function listServers() {
  return readJson('servers.json', []);
}

// What the renderer is allowed to see (never the secret itself).
function toPublic(server) {
  const { secret, ...rest } = server;
  return { ...rest, hasSecret: !!secret };
}

function getServer(id) {
  return listServers().find((s) => s.id === id);
}

function saveServer(input) {
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  if (!host) throw new Error('Host is required');
  if (!username) throw new Error('Username is required');

  const servers = listServers();
  const idx = servers.findIndex((s) => s.id === input.id);
  const existing = idx >= 0 ? servers[idx] : null;
  const authType = AUTH_TYPES.includes(input.authType) ? input.authType : 'auto';

  const server = {
    id: existing ? existing.id : crypto.randomUUID(),
    name: String(input.name || '').trim() || host,
    host,
    port: Number(input.port) || 22,
    username,
    authType,
    keyPath: authType === 'key' ? String(input.keyPath || '').trim() : '',
    // Keep the old secret only if the auth method didn't change.
    secret: existing && existing.authType === authType ? existing.secret : null,
  };
  if (authType === 'key' && !server.keyPath) throw new Error('Choose a private key file');
  if (input.secret) server.secret = encrypt(input.secret);
  if (input.clearSecret || authType === 'auto') server.secret = null;

  if (existing) servers[idx] = server;
  else servers.push(server);
  writeJson('servers.json', servers);
  return toPublic(server);
}

function deleteServer(id) {
  writeJson('servers.json', listServers().filter((s) => s.id !== id));
}

function getKnownHost(hostPort) {
  return readJson('known_hosts.json', {})[hostPort];
}

function setKnownHost(hostPort, fingerprint) {
  const known = readJson('known_hosts.json', {});
  known[hostPort] = fingerprint;
  writeJson('known_hosts.json', known);
}

const AI_DEFAULTS = { provider: 'claude', claudeModel: 'default', claudePath: '', routerUrl: 'http://localhost:20128/v1', routerModel: '' };

function getAiSettings({ includeSecret = false } = {}) {
  const saved = { ...AI_DEFAULTS, ...(readJson('settings.json', {}).ai || {}) };
  const settings = {
    provider: saved.provider,
    claudeModel: saved.claudeModel,
    claudePath: saved.claudePath,
    routerUrl: saved.routerUrl,
    routerModel: saved.routerModel,
    hasRouterKey: Boolean(saved.routerKey),
  };
  if (includeSecret) settings.routerKey = decrypt(saved.routerKey) || '';
  return settings;
}

function saveAiSettings(patch) {
  const all = readJson('settings.json', {});
  const ai = { ...AI_DEFAULTS, ...(all.ai || {}) };
  for (const key of ['provider', 'claudeModel', 'claudePath', 'routerUrl', 'routerModel']) {
    if (patch[key] !== undefined) ai[key] = String(patch[key]).trim();
  }
  if (!['claude', 'router', 'mandor'].includes(ai.provider)) ai.provider = 'claude';
  if (patch.routerKey !== undefined) ai.routerKey = patch.routerKey ? encrypt(patch.routerKey) : null;
  all.ai = ai;
  writeJson('settings.json', all);
  return getAiSettings();
}

const AI_MODES = ['readonly', 'normal', 'full'];
const MODE_RANK = { readonly: 0, normal: 1, full: 2 };

// A policy flag set by hand; there is deliberately no UI to change it. It can live either in
// settings.json under "aiPolicy", or in ai-policy.json next to the app, which is easier to edit
// and to keep in version control:
//   { "lockedMode": "readonly" }
// When both are set the stricter one wins, so neither file can be used to loosen the other.
function getProjectPolicy() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai-policy.json'), 'utf8'));
  } catch {
    return {};
  }
}

function getAiPolicy() {
  const candidates = [readJson('settings.json', {}).aiPolicy || {}, getProjectPolicy()]
    .map((raw) => raw.lockedMode)
    .filter((mode) => AI_MODES.includes(mode));
  if (!candidates.length) return { lockedMode: null };
  const lockedMode = candidates.reduce((a, b) => (MODE_RANK[a] <= MODE_RANK[b] ? a : b));
  return { lockedMode };
}

// Kept in settings.json rather than on the server record: saveServer() rebuilds that object from a
// fixed field list, so a mode stored there would be dropped whenever the user edits the connection.
function getServerAiMode(serverId) {
  const saved = (readJson('settings.json', {}).aiModes || {})[serverId];
  const stored = AI_MODES.includes(saved) ? saved : 'readonly';
  const { lockedMode } = getAiPolicy();
  if (!lockedMode) return stored;
  // The lock sets policy, but must never loosen a server that is already stricter.
  return MODE_RANK[stored] < MODE_RANK[lockedMode] ? stored : lockedMode;
}

function setServerAiMode(serverId, mode) {
  if (!AI_MODES.includes(mode)) throw new Error('Unknown security mode');
  const { lockedMode } = getAiPolicy();
  // Only loosening is refused: a server may still be set stricter than the lock.
  if (lockedMode && MODE_RANK[mode] > MODE_RANK[lockedMode]) {
    throw new Error(`The security mode is locked to "${lockedMode}" in settings.json.`);
  }
  const all = readJson('settings.json', {});
  all.aiModes = { ...(all.aiModes || {}), [serverId]: mode };
  writeJson('settings.json', all);
  return mode;
}

module.exports = {
  getAiSettings,
  saveAiSettings,
  getAiPolicy,
  getServerAiMode,
  setServerAiMode,
  listServers,
  getServer,
  saveServer,
  deleteServer,
  toPublic,
  decrypt,
  getKnownHost,
  setKnownHost,
};
