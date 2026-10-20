// Bridge between the sandboxed UI and the main process. The UI only gets these functions.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  // Saved servers
  listServers: () => call('servers:list'),
  saveServer: (server) => call('servers:save', server),
  deleteServer: (id) => call('servers:delete', id),
  sshConfigHosts: () => call('servers:sshConfigHosts'),
  pickKeyFile: () => call('dialog:pickKey'),
  connectedIds: () => call('servers:connectedIds'),
  showInFolder: (filePath) => call('shell:showItem', filePath),
  openUrl: (url) => call('shell:openUrl', url),

  // Connection
  connect: (id, secret) => call('ssh:connect', id, secret),
  disconnect: (id) => call('ssh:disconnect', id),
  onDisconnected: (handler) => on('ssh:closed', handler),
  onMenuRefresh: (handler) => on('menu:refresh', handler),

  // Server inspection
  overview: (id) => call('inspect:overview', id),
  apps: (id) => call('inspect:apps', id),
  services: (id) => call('inspect:services', id),
  docker: (id) => call('inspect:docker', id),
  ports: (id) => call('inspect:ports', id),
  processes: (id) => call('inspect:processes', id),
  users: (id) => call('inspect:users', id),
  capabilities: (id) => call('inspect:capabilities', id),

  // User management
  usersPasswordTemp: (id, name, password) => call('users:passwordTemp', id, name, password),
  usersGenerateKey: (id, name) => call('users:generateKey', id, name),

  // Installing software
  searchPackages: (id, query) => call('install:search', id, query),

  // Jobs (installs, service/container control, sudo saves, websites, HTTPS)
  startJob: (id, jobId, spec, password) => call('job:start', id, jobId, spec, password),
  onJobData: (handler) => on('job:data', handler),
  onJobExit: (handler) => on('job:exit', handler),

  // AI assistant
  aiSettings: () => call('ai:settings'),
  aiSaveSettings: (patch) => call('ai:saveSettings', patch),
  aiDetect: () => call('ai:detect'),
  pickClaudeBinary: () => call('dialog:pickClaudeBinary'),
  aiModels: () => call('ai:models'),
  aiMandorConnect: () => call('ai:mandorConnect'),
  aiMandorStatus: () => call('ai:mandorStatus'),
  aiMandorDisconnect: () => call('ai:mandorDisconnect'),
  aiCreateChat: (serverId) => call('ai:createChat', serverId),
  aiDisposeChat: (chatId) => call('ai:disposeChat', chatId),
  aiResetChat: (chatId) => call('ai:resetChat', chatId),
  aiSend: (chatId, text) => call('ai:send', chatId, text),
  aiStop: (chatId) => call('ai:stop', chatId),
  aiRespond: (chatId, requestId, response) => call('ai:respond', chatId, requestId, response),
  aiSetFolders: (chatId, folders) => call('ai:setFolders', chatId, folders),
  aiSetAutoApprove: (chatId, value) => call('ai:setAutoApprove', chatId, value),
  aiGetModeInfo: (chatId) => call('ai:getModeInfo', chatId),
  aiSetMode: (chatId, mode) => call('ai:setMode', chatId, mode),
  aiOpenAuditLog: () => call('ai:openAuditLog'),
  aiPickFolder: () => call('ai:pickFolder'),
  onAiEvent: (handler) => on('ai:event', handler),

  // Websites
  websites: (id) => call('inspect:websites', id),
  dnsCheck: (domain, serverHost) => call('dns:check', domain, serverHost),

  // Read-only database explorer (Elasticsearch, MongoDB, SQL Server), reached through SSH
  dbOpen: (id, config) => call('db:open', id, config),
  dbDatabases: (sessionId) => call('db:databases', sessionId),
  dbCollections: (sessionId, database) => call('db:collections', sessionId, database),
  dbBrowse: (sessionId, options) => call('db:browse', sessionId, options),
  dbSchema: (sessionId, options) => call('db:schema', sessionId, options),
  dbClose: (sessionId) => call('db:close', sessionId),

  // Notes attached to a container, image, Compose project, website or service
  notesList: (id) => call('notes:list', id),
  notesSave: (id, note) => call('notes:save', id, note),
  notesDelete: (id, kind, key) => call('notes:delete', id, kind, key),
  notesShareStatus: (id) => call('notes:shareStatus', id),

  // Files (SFTP)
  home: (id) => call('fs:home', id),
  listDir: (id, dir) => call('fs:list', id, dir),
  readText: (id, file) => call('fs:readText', id, file),
  writeText: (id, file, text) => call('fs:writeText', id, file, text),
  writeTemp: (id, text) => call('fs:writeTemp', id, text),
  download: (id, remotePath, isDir) => call('fs:download', id, remotePath, isDir),
  upload: (id, remoteDir) => call('fs:upload', id, remoteDir),
  uploadDropped: (id, remoteDir, files) =>
    call('fs:uploadPaths', id, remoteDir, [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  mkdir: (id, dir) => call('fs:mkdir', id, dir),
  rename: (id, from, to) => call('fs:rename', id, from, to),
  remove: (id, target, isDir) => call('fs:remove', id, target, isDir),

  // Terminal
  openTerminal: (id, cols, rows) => call('term:open', id, cols, rows),
  writeTerminal: (termId, data) => ipcRenderer.send('term:write', termId, data),
  resizeTerminal: (termId, cols, rows) => ipcRenderer.send('term:resize', termId, cols, rows),
  closeTerminal: (termId) => ipcRenderer.send('term:close', termId),
  onTerminalData: (handler) => on('term:data', handler),
  onTerminalExit: (handler) => on('term:exit', handler),
});
