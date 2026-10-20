const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, systemPreferences } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const store = require('./src/store');
const ssh = require('./src/ssh');
const inspect = require('./src/inspect');
const sshfiles = require('./src/sshfiles');
const install = require('./src/install');
const jobs = require('./src/jobs');
const websites = require('./src/websites');
const notes = require('./src/notes');
const ai = require('./src/ai');
const db = require('./src/db');
const crypto = require('crypto');

app.setName('Server Explorer');
app.setAppUserModelId('com.serverexplorer.app');

// One window only: a second launch focuses the running app.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

let win;

// Transparent caption buttons over the Mica header; only the glyph color follows the theme.
function titleBarOverlay() {
  return { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1b1b1b', height: 52 };
}

// Windows accent as a CSS variable, so buttons and selections match the user's system color.
function applyAccent() {
  const hex = systemPreferences.getAccentColor().slice(0, 6); // RRGGBBAA
  // Dark mode lightens it the way Windows does, so accent text stays readable on dark surfaces.
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    win.webContents.insertCSS(
      `:root{--accent:#${hex}}@media (prefers-color-scheme: dark){:root{--accent:color-mix(in srgb,#${hex} 55%,white)}}`
    );
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: 'Server Explorer',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    backgroundMaterial: 'mica',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', applyAccent);
}

nativeTheme.on('updated', () => win && !win.isDestroyed() && win.setTitleBarOverlay(titleBarOverlay()));
systemPreferences.on('accent-color-changed', () => win && !win.isDestroyed() && applyAccent());

// All invoke handlers return { ok, data } or { ok: false, error } so the UI gets clean messages.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function serverOrThrow(id) {
  const server = store.getServer(id);
  if (!server) throw new Error('Server not found');
  return server;
}

async function verifyHost(server, keyBlob) {
  const fp = sshfiles.fingerprint(keyBlob);
  const hostPort = `${server.host}:${server.port}`;
  const saved = store.getKnownHost(hostPort);
  if (saved === fp) return true;

  // Already trusted by the Terminal's ssh command? Then trust it here too.
  const openssh = sshfiles.checkOpenSshKnownHosts(server.host, server.port, keyBlob);
  if (openssh === 'match') {
    store.setKnownHost(hostPort, fp);
    return true;
  }

  if (saved || openssh === 'mismatch') {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Trust New Key'],
      defaultId: 0,
      cancelId: 0,
      message: `The host key for ${server.host} has changed`,
      detail:
        'This happens when a server is reinstalled, but it can also mean someone is intercepting the connection.\n\n' +
        `New fingerprint:\n${fp}\n\nOnly trust the new key if you know why it changed.`,
    });
    if (r.response !== 1) return false;
  } else {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Trust and Connect', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `First connection to ${server.host}`,
      detail: `Server key fingerprint:\n${fp}\n\nServer Explorer will remember this key and warn you if it ever changes.`,
    });
    if (r.response !== 0) return false;
  }
  store.setKnownHost(hostPort, fp);
  return true;
}

async function uploadPaths(serverId, remoteDir, localPaths) {
  const uploaded = [];
  const skipped = [];
  for (const local of localPaths) {
    const stat = fs.statSync(local);
    if (!stat.isFile()) {
      skipped.push(path.basename(local));
      continue;
    }
    await ssh.uploadFile(serverId, local, path.posix.join(remoteDir, path.basename(local)));
    uploaded.push(path.basename(local));
  }
  return { uploaded, skipped };
}

// ---------- IPC ----------

handle('servers:list', () => store.listServers().map(store.toPublic));
handle('servers:save', (server) => store.saveServer(server));
handle('servers:delete', (id) => {
  ssh.disconnect(id);
  store.deleteServer(id);
});
handle('servers:sshConfigHosts', () => sshfiles.readSshConfigHosts());
handle('servers:connectedIds', () => store.listServers().map((s) => s.id).filter(ssh.isConnected));
handle('dialog:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose private key',
    defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0];
});
handle('dialog:pickClaudeBinary', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose Claude CLI executable',
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0];
});
handle('shell:showItem', (filePath) => shell.showItemInFolder(filePath));
handle('shell:openUrl', (url) => {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Invalid URL');
  return shell.openExternal(url);
});

handle('ssh:connect', async (id, secret) => {
  const server = serverOrThrow(id);
  await ssh.connect(server, {
    secret: secret || store.decrypt(server.secret),
    verifyHost: (keyBlob) => verifyHost(server, keyBlob),
    onClose: () => send('ssh:closed', { serverId: id }),
  });
  return true;
});
handle('ssh:disconnect', (id) => ssh.disconnect(id));

handle('inspect:overview', (id) => inspect.overview(id));
handle('inspect:apps', (id) => inspect.apps(id));
handle('inspect:services', (id) => inspect.services(id));
handle('inspect:docker', (id) => inspect.docker(id));
handle('inspect:ports', (id) => inspect.ports(id));
handle('inspect:processes', (id) => inspect.processes(id));
handle('inspect:users', (id) => inspect.users(id));
handle('inspect:capabilities', (id) => inspect.capabilities(id));

// The new password goes to a private temp file, so it never appears in a command line or a log.
handle('users:passwordTemp', async (id, name, password) => {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(name || ''))) throw new Error('Invalid username');
  if (typeof password !== 'string' || password.length < 8) throw new Error('Use a password of at least 8 characters.');
  if (/[\n\r:]/.test(password)) throw new Error('The password cannot contain a colon or a line break.');
  const tmp = `/tmp/.se-pw-${crypto.randomUUID()}`;
  await ssh.writeText(id, tmp, `${name}:${password}\n`, 0o600);
  return tmp;
});

// Generates a key pair on the server, saves the private half on this PC, and removes both from the
// server. Only the public half is returned: a private key must not reach the renderer.
handle('users:generateKey', async (id, name) => {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(name || ''))) throw new Error('Invalid username');
  const server = serverOrThrow(id);
  const remote = `/tmp/.se-key-${crypto.randomUUID()}`;
  const gen = await ssh.exec(id, `ssh-keygen -t ed25519 -N '' -C '${name}@${server.name.replace(/[^A-Za-z0-9._-]/g, '')}' -f '${remote}'`, null, 60000);
  const cleanup = async () => {
    await ssh.remove(id, remote, false).catch(() => {});
    await ssh.remove(id, `${remote}.pub`, false).catch(() => {});
  };
  if (gen.code !== 0) {
    await cleanup();
    throw new Error(gen.stderr.trim() || 'Could not create a key pair on the server.');
  }
  let priv;
  let pub;
  try {
    priv = (await ssh.readText(id, remote)).text;
    pub = (await ssh.readText(id, `${remote}.pub`)).text;
  } finally {
    await cleanup();
  }
  const r = await dialog.showSaveDialog(win, {
    title: `Save the private key for ${name}`,
    defaultPath: path.join(app.getPath('downloads'), `id_ed25519_${name}`),
  });
  if (r.canceled || !r.filePath) return { saved: false, publicKey: pub.trim() };
  fs.writeFileSync(r.filePath, priv, { mode: 0o600 });
  // mode is ignored on Windows, and OpenSSH rejects a key whose ACL other accounts inherit.
  if (process.platform === 'win32') {
    const me = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    await new Promise((resolve) =>
      execFile('icacls', [r.filePath, '/inheritance:r', '/grant:r', `${me}:F`], { windowsHide: true }, resolve)
    );
  }
  return { saved: true, savedTo: r.filePath, publicKey: pub.trim() };
});
handle('inspect:websites', (id) => websites.list(id));
handle('dns:check', (domain, serverHost) => websites.dnsCheck(domain, serverHost));

// Per-item notes (credentials, connection strings, setup) for containers, websites and services.
handle('notes:list', (id) => notes.list(id));
handle('notes:save', (id, note) => notes.save(id, note || {}));
handle('notes:delete', (id, kind, key) => notes.remove(id, kind, key));
handle('notes:shareStatus', (id) => notes.shareStatus(id));

// Read-only database explorer, reached through the SSH session rather than a public port.
handle('db:open', (id, config) => db.open(id, config || {}));
handle('db:databases', (sessionId) => db.databases(sessionId));
handle('db:collections', (sessionId, database) => db.collections(sessionId, database));
handle('db:browse', (sessionId, options) => db.browse(sessionId, options || {}));
handle('db:schema', (sessionId, options) => db.schema(sessionId, options || {}));
handle('db:close', (sessionId) => db.close(sessionId));

handle('install:search', (id, query) => install.searchPackages(id, query));
// Without a typed password, fall back to this session's login password for sudo.
handle('job:start', async (id, jobId, spec, password) => {
  // startJob resolves with a { cancel } handle (a function) which can't cross IPC,
  // so it's discarded here; progress and results already arrive via job:data/job:exit.
  await jobs.startJob(id, spec, password || ssh.getSecret(id), {
    onData: (data) => send('job:data', { jobId, data }),
    onExit: (result) => send('job:exit', { jobId, ...result }),
  });
  return true;
});

// AI assistant
ai.init((chatId, event) => send('ai:event', { chatId, ...event }));
handle('ai:settings', () => store.getAiSettings());
handle('ai:saveSettings', (patch) => store.saveAiSettings(patch || {}));
handle('ai:detect', () => ai.detectClaude());
handle('ai:models', () => ai.routerModels());
handle('ai:mandorConnect', () => ai.mandorConnect());
handle('ai:mandorStatus', () => ai.mandorStatus());
handle('ai:mandorDisconnect', () => ai.mandorDisconnect());
handle('ai:createChat', (serverId) => ai.createChat(serverId));
handle('ai:disposeChat', (chatId) => ai.disposeChat(chatId));
handle('ai:resetChat', (chatId) => ai.resetChat(chatId));
handle('ai:send', (chatId, text) => {
  // Runs in the background; progress and the result arrive as ai:event messages.
  ai.send(chatId, String(text)).catch((err) => send('ai:event', { chatId, type: 'turn-end', error: err.message }));
  return true;
});
handle('ai:stop', (chatId) => ai.stop(chatId));
handle('ai:respond', (chatId, requestId, response) => ai.respond(chatId, requestId, response));
handle('ai:setFolders', (chatId, folders) => ai.setFolders(chatId, folders));
handle('ai:setAutoApprove', (chatId, value) => ai.setAutoApprove(chatId, value));
handle('ai:getModeInfo', (chatId) => ai.getModeInfo(chatId));
handle('ai:setMode', (chatId, mode) => ai.setMode(chatId, String(mode)));
handle('ai:openAuditLog', () => shell.openPath(ai.auditLogPath()));
handle('ai:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Share a folder with the AI (read-only)', properties: ['openDirectory'] });
  return r.canceled ? null : fs.realpathSync(r.filePaths[0]);
});

handle('fs:home', (id) => ssh.home(id));
handle('fs:list', (id, dir) => ssh.listDir(id, dir));
handle('fs:readText', (id, file) => ssh.readText(id, file));
handle('fs:writeText', (id, file, text) => ssh.writeText(id, file, text));
// Private temp copy used when a file can only be saved with sudo (see the writeFile job).
handle('fs:writeTemp', async (id, text) => {
  const tmp = `/tmp/.se-edit-${crypto.randomUUID()}`;
  await ssh.writeText(id, tmp, text, 0o600);
  return tmp;
});
handle('fs:mkdir', (id, dir) => ssh.mkdir(id, dir));
handle('fs:rename', (id, from, to) => ssh.rename(id, from, to));
handle('fs:remove', (id, target, isDir) => ssh.remove(id, target, isDir));
handle('fs:download', async (id, remotePath, isDir) => {
  const base = path.posix.basename(remotePath) || 'download';
  const r = await dialog.showSaveDialog(win, {
    title: isDir ? 'Download folder as archive' : 'Download file',
    defaultPath: path.join(app.getPath('downloads'), isDir ? `${base}.tar.gz` : base),
  });
  if (r.canceled || !r.filePath) return null;
  if (isDir) await ssh.downloadDirAsTar(id, remotePath, r.filePath);
  else await ssh.downloadFile(id, remotePath, r.filePath);
  return r.filePath;
});
handle('fs:upload', async (id, remoteDir) => {
  const r = await dialog.showOpenDialog(win, { title: 'Upload to server', properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return { uploaded: [], skipped: [] };
  return uploadPaths(id, remoteDir, r.filePaths);
});
handle('fs:uploadPaths', (id, remoteDir, localPaths) => uploadPaths(id, remoteDir, localPaths));

handle('term:open', (id, cols, rows) =>
  ssh.openShell(id, cols, rows, {
    onData: (termId, data) => send('term:data', { termId, data }),
    onExit: (termId) => send('term:exit', { termId }),
  })
);
ipcMain.on('term:write', (_e, termId, data) => ssh.writeShell(termId, data));
ipcMain.on('term:resize', (_e, termId, cols, rows) => ssh.resizeShell(termId, cols, rows));
ipcMain.on('term:close', (_e, termId) => ssh.closeShell(termId));

// ---------- App lifecycle ----------

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'fileMenu' },
      { role: 'editMenu' },
      {
        // Custom View menu: Cmd+R refreshes the current tab (handled in the UI) instead of reloading the window.
        label: 'View',
        submenu: [
          { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => send('menu:refresh') },
          { type: 'separator' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ])
  );
  if (primaryInstance) createWindow();
});

app.on('window-all-closed', () => {
  ssh.disconnectAll();
  app.quit();
});

app.on('before-quit', () => {
  ai.stopAll();
  ssh.disconnectAll();
});
