// Read-only Elasticsearch access over SSH. Every request opens its own forwarded channel from the
// server to the cluster, so nothing new is exposed on the network and no port needs to be public.
const http = require('http');
const ssh = require('../ssh');

const TIMEOUT_MS = 20000;
const MAX_RESPONSE = 8 * 1024 * 1024;
// Searches cannot page past index.max_result_window, which is 10000 unless someone raised it.
const RESULT_WINDOW = 10000;

// Index names as Elasticsearch accepts them. Anything else could turn the path into another API.
const INDEX = /^[^\\/*?"<>| ,#:\x00-\x1f]{1,255}$/;

function checkIndex(index) {
  const name = String(index || '');
  if (!INDEX.test(name) || name === '.' || name === '..') throw new Error('Invalid index name.');
  return name;
}

// http.ClientRequest expects a net.Socket. An SSH channel is a plain duplex stream, so the
// socket-only calls it can make are given harmless stand-ins.
function socketLike(stream) {
  for (const name of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref']) {
    if (typeof stream[name] !== 'function') stream[name] = () => stream;
  }
  return stream;
}

function friendly(err) {
  const message = String((err && (err.message || err.code || err.name)) || err);
  if (/administratively prohibited/i.test(message)) {
    return new Error('The server does not allow SSH port forwarding (AllowTcpForwarding is off in sshd_config).');
  }
  if (/open failed|refused|Channel open failure/i.test(message)) {
    return new Error('Could not reach Elasticsearch on the server. It may be stopped or listening on another address.');
  }
  if (/hang up|ECONNRESET/i.test(message)) {
    return new Error('Elasticsearch closed the connection. If it only accepts HTTPS, the explorer cannot open it yet.');
  }
  return err instanceof Error ? err : new Error(message);
}

function request(conn, method, path, body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json', Host: `${conn.host}:${conn.port}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (conn.username) {
      headers.Authorization = `Basic ${Buffer.from(`${conn.username}:${conn.password || ''}`).toString('base64')}`;
    }

    const req = http.request(
      {
        method,
        path,
        headers,
        // No `agent` on purpose: Node only honours createConnection when no agent is set, and even
        // `agent: false` counts as one, which silently sends the request to localhost on this PC.
        createConnection: (_options, onCreate) => {
          ssh.forwardOut(conn.serverId, conn.host, conn.port).then(
            (stream) => onCreate(null, socketLike(stream)),
            (err) => onCreate(err)
          );
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE) {
            req.destroy();
            done(new Error('The response was too large to show.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          if (res.statusCode === 401) return done(new Error('Elasticsearch rejected the username or password.'));
          if (res.statusCode >= 400) {
            const error = json && json.error;
            const reason =
              (error && error.root_cause && error.root_cause[0] && error.root_cause[0].reason) ||
              (error && error.reason) ||
              (typeof error === 'string' ? error : '') ||
              text.slice(0, 200);
            return done(new Error(`Elasticsearch answered ${res.statusCode}: ${reason}`));
          }
          if (json === null && text) return done(new Error('Elasticsearch sent a reply that is not JSON.'));
          return done(null, json);
        });
        res.on('error', (err) => done(friendly(err)));
      }
    );
    timer = setTimeout(() => {
      req.destroy();
      done(new Error('Elasticsearch took too long to answer.'));
    }, TIMEOUT_MS);
    req.on('error', (err) => done(friendly(err)));
    req.end(payload || undefined);
  });
}

async function info(conn) {
  const r = (await request(conn, 'GET', '/')) || {};
  return { name: r.name || '', cluster: r.cluster_name || '', version: (r.version && r.version.number) || '' };
}

async function indices(conn) {
  const rows = await request(conn, 'GET', '/_cat/indices?format=json&h=index,health,status,docs.count,store.size&bytes=b&s=index&expand_wildcards=all');
  return (rows || []).map((r) => ({
    name: r.index,
    health: r.health || '',
    status: r.status || '',
    docs: Number(r['docs.count']) || 0,
    bytes: Number(r['store.size']) || 0,
    // Dot names are system indices, except the backing indices of a data stream an app writes to:
    // `.ds-logs-app-…` holds real data, while `.ds-.kibana-…` belongs to the stack itself.
    hidden: String(r.index).startsWith('.') && !/^\.ds-[^.]/.test(String(r.index)),
  }));
}

// A search is read-only in Elasticsearch, so a query string is safe to accept here.
async function search(conn, index, { q = '', from = 0, size = 20 } = {}) {
  const name = checkIndex(index);
  const pageSize = Math.max(1, Math.min(Number(size) || 20, 100));
  const start = Math.max(0, Math.min(Number(from) || 0, RESULT_WINDOW - pageSize));
  const query = String(q || '').trim();
  const r = await request(conn, 'POST', `/${encodeURIComponent(name)}/_search`, {
    from: start,
    size: pageSize,
    track_total_hits: true,
    query: query ? { query_string: { query } } : { match_all: {} },
  });
  const hits = (r && r.hits && r.hits.hits) || [];
  const total = r && r.hits && r.hits.total;
  return {
    total: total && typeof total.value === 'number' ? total.value : hits.length,
    from: start,
    size: pageSize,
    maxFrom: RESULT_WINDOW - pageSize,
    hits: hits.map((h) => ({ id: h._id, index: h._index, source: h._source })),
  };
}

async function mapping(conn, index) {
  const name = checkIndex(index);
  return request(conn, 'GET', `/${encodeURIComponent(name)}/_mapping`);
}

// The shared explorer interface. Elasticsearch has one level: indices, with no database above them.
module.exports = {
  levels: 1,
  async open(conn) {
    const i = await info(conn);
    return { state: conn, info: { product: 'Elasticsearch', version: i.version, detail: i.cluster ? `cluster ${i.cluster}` : '' } };
  },
  async close() {},
  async collections(conn) {
    return (await indices(conn)).map((x) => ({ name: x.name, ref: x.name, count: x.docs, bytes: x.bytes, hidden: x.hidden, badge: x.health }));
  },
  async browse(conn, { ref, query = '', from = 0, size = 20 } = {}) {
    const r = await search(conn, ref, { q: query, from, size });
    return { kind: 'documents', paged: true, total: r.total, from: r.from, size: r.size, maxFrom: r.maxFrom, rows: r.hits.map((h) => ({ id: h.id, source: h.source })) };
  },
  schema: (conn, { ref } = {}) => mapping(conn, ref),
};
