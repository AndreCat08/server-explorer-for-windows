// Read-only MongoDB access over SSH. What exists here is listing, find with a filter, and a look at
// fields and indexes. No commands, no writes, and no aggregation beyond one fixed $sample.
const { MongoClient, BSON } = require('mongodb');
const tunnel = require('./tunnel');

const { EJSON } = BSON;
const QUERY_TIMEOUT_MS = 15000;
const SYSTEM_DATABASES = new Set(['admin', 'config', 'local']);
// These run JavaScript on the server. A read-only explorer has no reason to execute code there.
const CODE_OPERATORS = new Set(['$where', '$function', '$accumulator']);
const NAME = /^[^\0]{1,255}$/;
const AUTH_SOURCE = /^[A-Za-z0-9_.-]{1,64}$/;

function checkName(value, what) {
  const name = String(value || '');
  if (!NAME.test(name)) throw new Error(`Invalid ${what} name.`);
  return name;
}

function rejectCode(value) {
  if (Array.isArray(value)) {
    value.forEach(rejectCode);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (CODE_OPERATORS.has(key)) throw new Error(`${key} runs JavaScript on the server, so the explorer does not allow it.`);
      rejectCode(inner);
    }
  }
}

function parseFilter(text) {
  const source = String(text || '').trim();
  if (!source) return {};
  let filter;
  try {
    filter = EJSON.parse(source, { relaxed: true });
  } catch (err) {
    throw new Error(`The filter is not valid JSON: ${err.message}`);
  }
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error('The filter must be a JSON object, e.g. {"status": "failed"}.');
  }
  rejectCode(filter);
  return filter;
}

function friendly(err, t) {
  const message = String((err && (err.message || err.code)) || err);
  if (/Authentication failed/i.test(message)) return new Error('MongoDB rejected the username or password.');
  if (t && t.lastError) return new Error(`Could not reach MongoDB: ${t.lastError}.`);
  return err instanceof Error ? err : new Error(message);
}

const idText = (id) => {
  if (id === undefined) return '';
  if (id && id._bsontype === 'ObjectId') return id.toHexString();
  return typeof id === 'string' ? id : EJSON.stringify(id, { relaxed: true });
};

async function open(conn) {
  const authSource = conn.authSource || 'admin';
  if (!AUTH_SOURCE.test(authSource)) throw new Error('Invalid authentication database.');
  const t = await tunnel.open(conn.serverId, conn.host, conn.port);
  const auth = conn.username ? `${encodeURIComponent(conn.username)}:${encodeURIComponent(conn.password)}@` : '';
  const client = new MongoClient(`mongodb://${auth}127.0.0.1:${t.port}/?directConnection=true&authSource=${encodeURIComponent(authSource)}`, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    appName: 'Server Explorer',
  });
  try {
    await client.connect();
    const build = await client.db('admin').command({ buildInfo: 1 });
    return { state: { client, tunnel: t }, info: { product: 'MongoDB', version: build.version || '', detail: '' } };
  } catch (err) {
    await client.close().catch(() => {});
    const error = friendly(err, t);
    t.close();
    throw error;
  }
}

async function close(state) {
  await state.client.close().catch(() => {});
  state.tunnel.close();
}

async function databases(state) {
  const result = await state.client.db('admin').admin().listDatabases();
  return result.databases
    .map((d) => ({ name: d.name, bytes: d.sizeOnDisk || 0, hidden: SYSTEM_DATABASES.has(d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function collections(state, database) {
  const db = state.client.db(checkName(database, 'database'));
  const list = (await db.listCollections({}, { nameOnly: false }).toArray()).sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const c of list) {
    const count = c.type === 'view' ? null : await db.collection(c.name).estimatedDocumentCount({ maxTimeMS: QUERY_TIMEOUT_MS }).catch(() => null);
    out.push({ name: c.name, ref: c.name, count, hidden: c.name.startsWith('system.'), badge: c.type === 'view' ? 'view' : '' });
  }
  return out;
}

async function browse(state, { database, ref, query = '', from = 0, size = 20 } = {}) {
  const collection = state.client.db(checkName(database, 'database')).collection(checkName(ref, 'collection'));
  const filter = parseFilter(query);
  const pageSize = Math.max(1, Math.min(Number(size) || 20, 100));
  const start = Math.max(0, Math.floor(Number(from) || 0));
  const options = { maxTimeMS: QUERY_TIMEOUT_MS };
  const count = Object.keys(filter).length
    ? collection.countDocuments(filter, options)
    : // Views have no estimate, so they fall back to an exact count.
      collection.estimatedDocumentCount(options).catch(() => collection.countDocuments({}, options));
  const [total, docs] = await Promise.all([count, collection.find(filter).skip(start).limit(pageSize).maxTimeMS(QUERY_TIMEOUT_MS).toArray()]);
  return {
    kind: 'documents',
    paged: true,
    total,
    from: start,
    size: pageSize,
    maxFrom: Number.MAX_SAFE_INTEGER,
    rows: docs.map((d) => ({ id: idText(d._id), source: EJSON.serialize(d, { relaxed: true }) })),
  };
}

// Field names and their types from a sample of documents, plus the indexes: what someone needs to
// write a filter, without scanning the whole collection.
async function schema(state, { database, ref } = {}) {
  const collection = state.client.db(checkName(database, 'database')).collection(checkName(ref, 'collection'));
  const [indexes, sample] = await Promise.all([
    collection.indexes().catch(() => []),
    collection.aggregate([{ $sample: { size: 50 } }], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray().catch(() => []),
  ]);
  const fields = {};
  const typeOf = (v) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (v instanceof Date) return 'date';
    if (v && v._bsontype) return v._bsontype;
    return typeof v;
  };
  const walk = (doc, prefix, depth) => {
    for (const [key, value] of Object.entries(doc)) {
      const path = prefix ? `${prefix}.${key}` : key;
      (fields[path] ||= new Set()).add(typeOf(value));
      if (depth < 3 && typeOf(value) === 'object') walk(value, path, depth + 1);
    }
  };
  for (const doc of sample) walk(doc, '', 0);
  return {
    sampledDocuments: sample.length,
    fields: Object.fromEntries(Object.keys(fields).sort().map((k) => [k, [...fields[k]]])),
    indexes: EJSON.serialize(indexes, { relaxed: true }),
  };
}

module.exports = { levels: 2, open, close, databases, collections, browse, schema };
