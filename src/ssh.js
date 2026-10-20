// SSH session manager: one ssh2 connection per server, shared by exec, SFTP and terminals.
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { expandHome, defaultKeyPaths } = require('./sshfiles');

const sessions = new Map(); // serverId -> { client, sftpPromise, shells: Map<termId, stream> }
const shells = new Map(); // termId -> { serverId, stream }

function buildAuth(server, secret) {
  const username = server.username;
  const methods = [];
  if (server.authType === 'password') {
    methods.push({ type: 'password', username, password: secret || '' });
    methods.push({
      type: 'keyboard-interactive',
      username,
      prompt: (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => secret || '')),
    });
  } else if (server.authType === 'key') {
    const keyFile = expandHome(server.keyPath);
    let key;
    try {
      key = fs.readFileSync(keyFile);
    } catch {
      throw new Error(`Cannot read private key: ${keyFile}`);
    }
    methods.push({ type: 'publickey', username, key, passphrase: secret });
  } else {
    // "auto": behave like the ssh command — agent first, then default keys without passphrase.
    if (process.env.SSH_AUTH_SOCK) {
      methods.push({ type: 'agent', username, agent: process.env.SSH_AUTH_SOCK });
    }
    for (const keyFile of defaultKeyPaths()) {
      methods.push({ type: 'publickey', username, key: fs.readFileSync(keyFile) });
    }
  }
  return methods;
}

function friendlyError(err, server) {
  const msg = String((err && err.message) || err);
  if (err && err.code === 'ECONNREFUSED') return `Connection refused by ${server.host}:${server.port}. Is SSH running on that port?`;
  if (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')) return `Host not found: ${server.host}`;
  if (err && (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH')) return `Cannot reach ${server.host}:${server.port} (network timeout).`;
  if (/handshake/i.test(msg)) return `Timed out connecting to ${server.host}:${server.port}.`;
  if (/authentication methods failed/i.test(msg)) {
    if (server.authType === 'auto') return 'Authentication failed. None of your SSH keys (~/.ssh) were accepted. Try a specific key file or a password.';
    if (server.authType === 'key') return 'Authentication failed. The key was rejected, or its passphrase is wrong.';
    return 'Authentication failed. Check the username and password.';
  }
  if (/verification failed/i.test(msg)) return 'Connection cancelled: the host key was not trusted.';
  return msg;
}

function connect(server, { secret, verifyHost, onClose }) {
  if (sessions.has(server.id)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let authHandler;
    try {
      authHandler = buildAuth(server, secret);
    } catch (err) {
      reject(err);
      return;
    }

    const client = new Client();
    let ready = false;

    client.on('ready', () => {
      ready = true;
      // A login password stays in memory for this session only, so installs can reuse it for sudo.
      sessions.set(server.id, { client, sftpPromise: null, secret: server.authType === 'password' ? secret : undefined });
      resolve();
    });
    client.on('error', (err) => {
      if (!ready) reject(new Error(friendlyError(err, server)));
    });
    client.on('close', () => {
      const wasOpen = sessions.get(server.id)?.client === client;
      if (wasOpen) sessions.delete(server.id);
      for (const [termId, sh] of shells) {
        if (sh.serverId === server.id) shells.delete(termId);
      }
      if (!ready) reject(new Error(`Connection to ${server.host} closed.`));
      else if (wasOpen) onClose();
    });

    client.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      authHandler,
      tryKeyboard: server.authType === 'password',
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      hostVerifier: (keyBlob, verify) => {
        verifyHost(keyBlob).then(verify, () => verify(false));
      },
    });
  });
}

function disconnect(serverId) {
  const s = sessions.get(serverId);
  if (!s) return;
  sessions.delete(serverId);
  s.client.end();
}

function disconnectAll() {
  for (const id of [...sessions.keys()]) disconnect(id);
}

function need(serverId) {
  const s = sessions.get(serverId);
  if (!s) throw new Error('Not connected');
  return s;
}

// Opens a TCP connection from the server itself to host:port, carried inside the SSH session.
// Services that only listen on the server become reachable without opening them to the network.
function forwardOut(serverId, host, port) {
  return new Promise((resolve, reject) => {
    const { client } = need(serverId);
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

// Runs a command. `input` is written to stdin (used to pipe shell scripts into `sh -s`).
function exec(serverId, command, input, timeoutMs = 60000) {
  const { client } = need(serverId);
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      const out = [];
      const errOut = [];
      let code = null;
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error('The server took too long to respond.'));
      }, timeoutMs);
      stream.on('data', (d) => out.push(d));
      stream.stderr.on('data', (d) => errOut.push(d));
      stream.on('exit', (c) => (code = c));
      stream.on('close', () => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errOut).toString('utf8'),
        });
      });
      if (input != null) stream.end(input);
    });
  });
}

// Runs a long command and streams its output (stdout and stderr interleaved) as it arrives.
function execStream(serverId, command, input, { onData, onExit }) {
  const { client } = need(serverId);
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      const out = new StringDecoder('utf8');
      const errOut = new StringDecoder('utf8');
      let code = null;
      let stderrHead = '';
      stream.on('data', (d) => onData(out.write(d)));
      stream.stderr.on('data', (d) => {
        const text = errOut.write(d);
        if (stderrHead.length < 2000) stderrHead += text;
        onData(text);
      });
      stream.on('exit', (c) => (code = c));
      stream.on('close', () => onExit({ code, stderrHead }));
      stream.end(input || undefined);
      resolve({ cancel: () => stream.close() });
    });
  });
}

function runScript(serverId, script, timeoutMs) {
  return exec(serverId, 'sh -s', script, timeoutMs);
}

// ---------- SFTP ----------

function sftp(serverId) {
  const s = need(serverId);
  if (!s.sftpPromise) {
    s.sftpPromise = new Promise((resolve, reject) => {
      s.client.sftp((err, sftpClient) => {
        if (err) {
          s.sftpPromise = null;
          return reject(err);
        }
        sftpClient.on('close', () => (s.sftpPromise = null));
        resolve(sftpClient);
      });
    });
  }
  return s.sftpPromise;
}

const promisify = (fn) => new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

async function home(serverId) {
  const c = await sftp(serverId);
  return promisify((cb) => c.realpath('.', cb));
}

async function listDir(serverId, dir) {
  const c = await sftp(serverId);
  const resolved = await promisify((cb) => c.realpath(dir, cb));
  const entries = await promisify((cb) => c.readdir(resolved, cb));
  return {
    path: resolved,
    entries: await Promise.all(
      entries.map(async (e) => {
        const kind = e.attrs.mode & S_IFMT;
        const full = path.posix.join(resolved, e.filename);
        const parts = e.longname.split(/\s+/);
        const item = {
          name: e.filename,
          path: full,
          size: e.attrs.size,
          mtime: e.attrs.mtime * 1000,
          mode: e.attrs.mode,
          perms: parts[0] || '',
          owner: parts[2] || String(e.attrs.uid),
          group: parts[3] || String(e.attrs.gid),
          isDir: kind === S_IFDIR,
          isLink: kind === S_IFLNK,
        };
        if (item.isLink) {
          try {
            const target = await promisify((cb) => c.stat(full, cb));
            item.isDir = (target.mode & S_IFMT) === S_IFDIR;
          } catch {
            item.broken = true;
          }
        }
        return item;
      })
    ),
  };
}

const PREVIEW_LIMIT = 2 * 1024 * 1024;

async function readText(serverId, file) {
  const c = await sftp(serverId);
  const stat = await promisify((cb) => c.stat(file, cb));
  if (stat.size > PREVIEW_LIMIT) {
    return { tooLarge: true, size: stat.size };
  }
  const buf = await promisify((cb) => c.readFile(file, cb));
  const sample = buf.subarray(0, 8000);
  if (sample.includes(0)) return { binary: true, size: stat.size };
  return { text: buf.toString('utf8'), size: stat.size };
}

async function writeText(serverId, file, text, mode) {
  const c = await sftp(serverId);
  await promisify((cb) => c.writeFile(file, Buffer.from(text, 'utf8'), mode ? { mode } : {}, cb));
}

async function downloadFile(serverId, remotePath, localPath) {
  const c = await sftp(serverId);
  await promisify((cb) => c.fastGet(remotePath, localPath, cb));
}

// Folders are streamed as a tar.gz archive created on the server.
function downloadDirAsTar(serverId, remotePath, localPath) {
  const { client } = need(serverId);
  const parent = path.posix.dirname(remotePath);
  const name = path.posix.basename(remotePath);
  return new Promise((resolve, reject) => {
    client.exec(`tar -czf - -C ${q(parent)} -- ${q(name)}`, (err, stream) => {
      if (err) return reject(err);
      const file = fs.createWriteStream(localPath);
      const errOut = [];
      let code = 0;
      stream.stderr.on('data', (d) => errOut.push(d));
      stream.on('exit', (c) => (code = c));
      stream.pipe(file);
      file.on('finish', () => {
        if (code) reject(new Error(Buffer.concat(errOut).toString() || `tar exited with ${code}`));
        else resolve();
      });
      file.on('error', reject);
    });
  });
}

async function uploadFile(serverId, localPath, remotePath) {
  const c = await sftp(serverId);
  await promisify((cb) => c.fastPut(localPath, remotePath, cb));
}

async function mkdir(serverId, dir) {
  const c = await sftp(serverId);
  await promisify((cb) => c.mkdir(dir, cb));
}

async function rename(serverId, from, to) {
  const c = await sftp(serverId);
  await promisify((cb) => c.rename(from, to, cb));
}

async function remove(serverId, target, isDir) {
  if (isDir) {
    const res = await exec(serverId, `rm -rf -- ${q(target)}`);
    if (res.code) throw new Error(res.stderr.trim() || 'Delete failed');
    return;
  }
  const c = await sftp(serverId);
  await promisify((cb) => c.unlink(target, cb));
}

// ---------- Interactive terminal ----------

function openShell(serverId, cols, rows, { onData, onExit }) {
  const { client } = need(serverId);
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) return reject(err);
      const termId = crypto.randomUUID();
      const decoder = new StringDecoder('utf8');
      shells.set(termId, { serverId, stream });
      stream.on('data', (d) => onData(termId, decoder.write(d)));
      stream.stderr?.on('data', (d) => onData(termId, decoder.write(d)));
      stream.on('close', () => {
        shells.delete(termId);
        onExit(termId);
      });
      resolve(termId);
    });
  });
}

function writeShell(termId, data) {
  shells.get(termId)?.stream.write(data);
}

function resizeShell(termId, cols, rows) {
  shells.get(termId)?.stream.setWindow(rows, cols, 0, 0);
}

function closeShell(termId) {
  const sh = shells.get(termId);
  if (sh) {
    shells.delete(termId);
    sh.stream.close();
  }
}

// Single-quote a string for POSIX shells.
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  connect,
  disconnect,
  disconnectAll,
  isConnected: (id) => sessions.has(id),
  getSecret: (id) => sessions.get(id)?.secret,
  exec,
  forwardOut,
  runScript,
  execStream,
  home,
  listDir,
  readText,
  writeText,
  downloadFile,
  downloadDirAsTar,
  uploadFile,
  mkdir,
  rename,
  remove,
  openShell,
  writeShell,
  resizeShell,
  closeShell,
};
