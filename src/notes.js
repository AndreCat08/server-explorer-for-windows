// Per-item notes: connection strings, credentials, ports and setup steps attached to a Docker
// container, image or Compose project, a website, or a service. The user writes them, and so can the
// AI assistant after it sets something up.
//
// Notes live on the PC, encrypted with safeStorage exactly like the SSH secrets in store.js, so a
// compromised server never yields one file holding every credential. A note can optionally also be
// copied to the server for teammates; that copy is plain text, which is why it is off by default.
//
// Copies go to a team folder (/srv/server-explorer/notes) once someone has shared notes with a group,
// and to the login user's home otherwise. Both places are read back when notes are listed, so a
// teammate's Server Explorer shows what was saved from another PC. The newest version wins.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');

// 'port' is internal: the firewall description for tools that cannot store one themselves.
const KINDS = ['container', 'image', 'compose', 'website', 'service', 'port'];
const SERVER_DIR = '.server-explorer/notes';
const SHARED_DIR = '/srv/server-explorer/notes';
const MAX_BODY = 100000;
const MAX_LINE = 200;
// Reading copies back costs a few SSH round trips, and every tab load lists notes.
const SYNC_INTERVAL_MS = 30000;
// Older copies stamped the moment they were written, a little after the note's own time. Without
// some slack that gap alone would make every old copy look newer than the note it came from.
const NEWER_BY_MS = 2000;

const filePath = () => path.join(app.getPath('userData'), 'notes.json');
const entryKey = (kind, key) => `${kind}:${key}`;
// Note keys are container names, domains and the like; keep the server filename tame.
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
const copyName = (note) => `${safeName(note.kind)}-${safeName(note.key)}.md`;
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const lastSync = new Map(); // serverId -> time of the last read-back

function readAll() {
  try {
    const stored = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    const buf = Buffer.from(stored.data, 'base64');
    return JSON.parse(stored.enc ? safeStorage.decryptString(buf) : buf.toString('utf8'));
  } catch {
    return {};
  }
}

function writeAll(all) {
  const text = JSON.stringify(all);
  const stored = safeStorage.isEncryptionAvailable()
    ? { enc: true, data: safeStorage.encryptString(text).toString('base64') }
    : { enc: false, data: Buffer.from(text, 'utf8').toString('base64') };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(stored), { mode: 0o600 });
}

function clean(value, limit) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

// Whether notes on this server are shared with a group, and where copies go.
async function shareStatus(serverId) {
  lastSync.delete(serverId);
  const home = await ssh.home(serverId);
  const res = await ssh.exec(
    serverId,
    `if [ -d ${SHARED_DIR} ] && [ -w ${SHARED_DIR} ]; then stat -c %G ${SHARED_DIR}; fi`,
    null,
    20000
  );
  const group = res.code === 0 ? res.stdout.trim() : '';
  return { shared: Boolean(group), group, sharedDir: SHARED_DIR, homeDir: `${home}/${SERVER_DIR}` };
}

function formatCopy(note) {
  return [
    '---',
    'server-explorer-note: 1',
    `kind: ${oneLine(note.kind)}`,
    `key: ${oneLine(note.key)}`,
    `title: ${oneLine(note.title)}`,
    `updated: ${note.updatedAt}`,
    '---',
    '',
    `# ${oneLine(note.title)}`,
    '',
    note.body,
    '',
  ].join('\n');
}

// Reads a copy back. Copies written before the header existed are still understood.
function parseCopy(text) {
  const src = String(text || '');
  const header = src.match(/^---\n([\s\S]*?)\n---\n\n# [^\n]*\n\n?([\s\S]*)$/);
  if (header) {
    const fields = {};
    for (const line of header[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { kind: fields.kind, key: fields.key, title: fields.title, updatedAt: fields.updated, body: header[2].replace(/\n$/, '') };
  }
  const old = src.match(/^# ([^\n]*)\n\nFor ([a-z]+): ([^\n]*)\nSaved by Server Explorer on ([^\n]+)\n\n([\s\S]*)$/);
  if (old) return { title: old[1], kind: old[2], key: old[3], updatedAt: old[4], body: old[5].replace(/\n$/, '') };
  return null;
}

// Brings copies saved from any PC into this one's store. Never deletes a local note.
async function syncFromServer(serverId) {
  if (!ssh.isConnected(serverId)) return;
  const now = Date.now();
  if (now - (lastSync.get(serverId) || 0) < SYNC_INTERVAL_MS) return;
  lastSync.set(serverId, now);

  const home = await ssh.home(serverId);
  const found = new Map();
  for (const dir of [SHARED_DIR, `${home}/${SERVER_DIR}`]) {
    let listing;
    try {
      listing = await ssh.listDir(serverId, dir);
    } catch {
      continue;
    }
    for (const entry of listing.entries) {
      if (entry.isDir || !entry.name.endsWith('.md')) continue;
      let parsed;
      try {
        parsed = parseCopy((await ssh.readText(serverId, entry.path)).text);
      } catch {
        continue;
      }
      if (!parsed || !KINDS.includes(parsed.kind) || !parsed.key || !parsed.title) continue;
      const time = Date.parse(parsed.updatedAt) || entry.mtime;
      const k = entryKey(parsed.kind, parsed.key);
      if (!found.has(k) || time > found.get(k).time) found.set(k, { ...parsed, time, path: entry.path });
    }
  }
  if (!found.size) return;

  const all = readAll();
  const forServer = (all[serverId] ||= {});
  let changed = false;
  for (const [k, copy] of found) {
    const local = forServer[k];
    const localTime = Date.parse(local?.updatedAt) || 0;
    if (!local || copy.time > localTime + NEWER_BY_MS) {
      forServer[k] = {
        kind: copy.kind,
        key: clean(copy.key, MAX_LINE),
        title: clean(copy.title, MAX_LINE),
        body: String(copy.body).slice(0, MAX_BODY),
        onServer: true,
        updatedAt: new Date(copy.time).toISOString(),
        serverPath: copy.path,
      };
      changed = true;
    } else if (!local.onServer || local.serverPath !== copy.path) {
      // Same note, already current here: it just was not known to have a copy.
      local.onServer = true;
      local.serverPath = copy.path;
      changed = true;
    }
  }
  if (changed) writeAll(all);
}

async function list(serverId) {
  // A server that cannot be read must not hide the notes already on this PC.
  await syncFromServer(serverId).catch(() => {});
  const forServer = readAll()[serverId] || {};
  return Object.values(forServer).sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

function get(serverId, kind, key) {
  return (readAll()[serverId] || {})[entryKey(kind, key)] || null;
}

// Writes the readable copy. With a team folder it goes there, readable and writable by the group;
// otherwise it stays in the login user's home, where only that user can read it.
async function writeServerCopy(serverId, note) {
  const status = await shareStatus(serverId);
  const dir = status.shared ? SHARED_DIR : status.homeDir;
  if (!status.shared) {
    const res = await ssh.exec(serverId, `mkdir -p -- ${shellQuote(dir)}`, null, 30000);
    if (res.code !== 0) throw new Error(res.stderr.trim() || `Could not create ${dir} on the server.`);
  }
  const target = `${dir}/${copyName(note)}`;
  await ssh.writeText(serverId, target, formatCopy(note), status.shared ? 0o660 : 0o600);
  // Once the team folder exists, a private copy of the same note would only go stale.
  if (status.shared) await ssh.remove(serverId, `${status.homeDir}/${copyName(note)}`, false).catch(() => {});
  return target;
}

async function removeServerCopy(serverId, note) {
  const home = await ssh.home(serverId);
  for (const dir of [SHARED_DIR, `${home}/${SERVER_DIR}`]) {
    await ssh.remove(serverId, `${dir}/${copyName(note)}`, false).catch(() => {});
  }
}

async function save(serverId, input) {
  const kind = clean(input.kind, 40);
  const key = clean(input.key, MAX_LINE);
  const title = clean(input.title, MAX_LINE);
  const body = String(input.body == null ? '' : input.body).slice(0, MAX_BODY);
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  if (!key) throw new Error('The note needs the name of the item it belongs to.');
  if (!title) throw new Error('Give the note a short title.');

  const all = readAll();
  const forServer = (all[serverId] ||= {});
  const previous = forServer[entryKey(kind, key)];
  const note = { kind, key, title, body, onServer: Boolean(input.onServer), updatedAt: new Date().toISOString(), serverPath: '' };

  // The local copy is saved first: it is the one that must not be lost.
  forServer[entryKey(kind, key)] = note;
  writeAll(all);

  if (note.onServer) {
    try {
      note.serverPath = await writeServerCopy(serverId, note);
    } catch (err) {
      // The choice is kept. Unticking it here used to erase what the user asked for with nothing to
      // show for it later; the error stays on the note so the dialog can say the copy is missing
      // until a later save succeeds.
      note.serverError = `Saved on this PC, but the copy on the server failed: ${err.message}`;
    }
    writeAll(all);
  } else if (previous?.onServer) {
    // Turning the server copy off should take the plain-text file with it.
    await removeServerCopy(serverId, previous).catch(() => {});
  }
  return note;
}

async function remove(serverId, kind, key) {
  const all = readAll();
  const forServer = all[serverId] || {};
  const previous = forServer[entryKey(kind, key)];
  if (!previous) return true;
  delete forServer[entryKey(kind, key)];
  writeAll(all);
  if (previous.onServer) await removeServerCopy(serverId, previous).catch(() => {});
  return true;
}

module.exports = { KINDS, SHARED_DIR, list, get, save, remove, shareStatus };
