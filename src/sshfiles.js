// Helpers for the user's local OpenSSH files (~/.ssh/config, ~/.ssh/known_hosts, default keys).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SSH_DIR = path.join(os.homedir(), '.ssh');
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultKeyPaths() {
  return DEFAULT_KEYS.map((k) => path.join(SSH_DIR, k)).filter((p) => fs.existsSync(p));
}

// Parses ~/.ssh/config into a list of concrete hosts (wildcard patterns are skipped).
function readSshConfigHosts() {
  let text;
  try {
    text = fs.readFileSync(path.join(SSH_DIR, 'config'), 'utf8');
  } catch {
    return [];
  }
  const hosts = [];
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = value
        .split(/\s+/)
        .filter((alias) => alias && !/[*?!]/.test(alias))
        .map((alias) => ({ alias, host: alias, port: 22, username: '', identityFile: '' }));
      hosts.push(...current);
    } else if (key === 'match') {
      current = [];
    } else {
      for (const h of current) {
        if (key === 'hostname') h.host = value;
        else if (key === 'user') h.username = value;
        else if (key === 'port') h.port = Number(value) || 22;
        else if (key === 'identityfile' && !h.identityFile) h.identityFile = expandHome(value);
      }
    }
  }
  return hosts;
}

function fingerprint(keyBlob) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');
}

// Returns 'match' if ~/.ssh/known_hosts trusts this exact key, 'mismatch' if it lists the
// host with a different key of the same type, or 'unknown'.
function checkOpenSshKnownHosts(host, port, keyBlob) {
  let text;
  try {
    text = fs.readFileSync(path.join(SSH_DIR, 'known_hosts'), 'utf8');
  } catch {
    return 'unknown';
  }
  const name = port === 22 ? host : `[${host}]:${port}`;
  const keyType = readKeyType(keyBlob);
  const keyB64 = keyBlob.toString('base64');
  let sawSameType = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;
    const [hostsField, type, b64] = line.split(/\s+/);
    if (!b64 || !hostMatches(hostsField, name)) continue;
    if (b64 === keyB64) return 'match';
    if (type === keyType) sawSameType = true;
  }
  return sawSameType ? 'mismatch' : 'unknown';
}

function hostMatches(field, name) {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    const digest = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
    return digest === hash;
  }
  return field.split(',').includes(name);
}

function readKeyType(blob) {
  try {
    const len = blob.readUInt32BE(0);
    return blob.subarray(4, 4 + len).toString('ascii');
  } catch {
    return '';
  }
}

module.exports = {
  expandHome,
  defaultKeyPaths,
  readSshConfigHosts,
  fingerprint,
  checkOpenSshKnownHosts,
};
