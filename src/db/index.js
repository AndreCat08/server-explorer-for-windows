// Database explorer sessions. Read-only by design: an engine exposes listing and reading only, never
// a raw request, so nothing reachable from here can change data on the server.
//
// Every engine answers the same questions: which databases (engines with one level have none), which
// collections, indices or tables are in one, a page of their contents, and their shape.
const crypto = require('crypto');
const elasticsearch = require('./elasticsearch');
const mongodb = require('./mongodb');
const mssql = require('./mssql');

const ENGINES = { elasticsearch, mongodb, mssql };
// The address is seen from the server, so only loopback names and plain IPv4 are accepted.
const HOST = /^(localhost|(\d{1,3}\.){3}\d{1,3})$/;

// id -> { engine, state }. Credentials and connections stay in this process for the life of the window.
const sessions = new Map();

function need(id) {
  const session = sessions.get(id);
  if (!session) throw new Error('This database connection was closed. Open the explorer again.');
  return session;
}

async function open(serverId, config = {}) {
  const engine = ENGINES[config.engine];
  if (!engine) throw new Error('That kind of database is not supported yet.');
  const host = String(config.host || '');
  const port = Number(config.port);
  if (!HOST.test(host)) throw new Error('Invalid database host.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid database port.');
  const conn = {
    serverId: String(serverId),
    host,
    port,
    username: config.username ? String(config.username) : '',
    password: config.password ? String(config.password) : '',
    authSource: config.authSource ? String(config.authSource) : '',
  };
  // Fails here, before a session exists, when the address or the login is wrong.
  const { state, info } = await engine.open(conn);
  const id = crypto.randomUUID();
  sessions.set(id, { engine, state });
  return { id, info, levels: engine.levels };
}

async function close(id) {
  const session = sessions.get(id);
  sessions.delete(id);
  if (session && session.engine.close) await session.engine.close(session.state).catch(() => {});
}

module.exports = {
  open,
  close,
  databases: (id) => {
    const s = need(id);
    return s.engine.databases ? s.engine.databases(s.state) : [];
  },
  collections: (id, database) => {
    const s = need(id);
    return s.engine.collections(s.state, database);
  },
  browse: (id, options) => {
    const s = need(id);
    return s.engine.browse(s.state, options || {});
  },
  schema: (id, options) => {
    const s = need(id);
    return s.engine.schema(s.state, options || {});
  },
};
