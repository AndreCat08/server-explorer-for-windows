// Read-only SQL Server access over SSH. Browsing uses fixed, parameterised statements. The query box
// takes one SELECT, is screened for anything that writes or runs code, and always runs inside a
// transaction that is rolled back, so a statement that got past the screen still changes nothing.
const sql = require('mssql');
const tunnel = require('./tunnel');

const QUERY_TIMEOUT_MS = 20000;
const MAX_QUERY_ROWS = 500;
// Checked after comments, strings and quoted names are blanked out, so none of them can hide a word.
const FORBIDDEN =
  /\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|deny|into|backup|restore|dbcc|shutdown|kill|openrowset|opendatasource|openquery|openxml|reconfigure|use|declare|set|waitfor|bulk|receive|send|checkpoint|begin|commit|rollback|save|go)\b|\b(sp|xp)_\w+/i;

const quoteName = (name) => `[${String(name).replace(/]/g, ']]')}]`;

// Walks the text the way SQL Server reads it, replacing comments (which nest), string literals and
// quoted identifiers with placeholders. What is left is only the words that actually execute.
function screenText(text) {
  const s = String(text);
  let out = '';
  let i = 0;
  const skipQuoted = (close) => {
    i += 1;
    while (i < s.length) {
      if (s[i] === close) {
        if (s[i + 1] === close) {
          i += 2;
          continue;
        }
        i += 1;
        return;
      }
      i += 1;
    }
  };
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === '-' && next === '-') {
      const end = s.indexOf('\n', i);
      i = end < 0 ? s.length : end;
      out += ' ';
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < s.length && depth) {
        if (s[i] === '/' && s[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (s[i] === '*' && s[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      out += ' ';
    } else if (ch === "'") {
      skipQuoted("'");
      out += "''";
    } else if (ch === '[') {
      skipQuoted(']');
      out += '[x]';
    } else if (ch === '"') {
      skipQuoted('"');
      out += '"x"';
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function checkReadOnly(query) {
  const screened = screenText(query).trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(screened)) throw new Error('Only a single SELECT query can run here.');
  if (screened.includes(';')) throw new Error('Run one statement at a time.');
  const hit = screened.match(FORBIDDEN);
  if (hit) throw new Error(`"${hit[0]}" is not allowed here: the explorer is read-only. Put [brackets] around a column with that name.`);
}

function cell(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return `0x${value.subarray(0, 64).toString('hex')}${value.length > 64 ? '…' : ''}`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Rows as arrays, so two columns that share a name both survive.
function table(result) {
  const last = Math.max(0, (result.recordsets || []).length - 1);
  const rows = (result.recordsets && result.recordsets[last]) || [];
  const meta = (result.columns && result.columns[last]) || [];
  return { columns: meta.map((c) => c.name || '(no name)'), rows: rows.map((r) => r.map(cell)) };
}

function friendly(err, t) {
  const message = String((err && (err.message || err.code)) || err);
  if (/Login failed/i.test(message)) return new Error('SQL Server rejected the username or password.');
  if (t && t.lastError) return new Error(`Could not reach SQL Server: ${t.lastError}.`);
  return err instanceof Error ? err : new Error(message);
}

async function open(conn) {
  const t = await tunnel.open(conn.serverId, conn.host, conn.port);
  const pool = new sql.ConnectionPool({
    server: '127.0.0.1',
    port: t.port,
    user: conn.username,
    password: conn.password,
    database: 'master',
    connectionTimeout: 15000,
    requestTimeout: QUERY_TIMEOUT_MS,
    pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
    // Encrypted, but the certificate is not verified: SQL Server containers ship a self-signed one,
    // and the connection already travels inside SSH to the server's own loopback address.
    options: { encrypt: true, trustServerCertificate: true },
  });
  try {
    await pool.connect();
    const r = await pool
      .request()
      .query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS version, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition");
    const row = r.recordset[0] || {};
    return { state: { pool, tunnel: t }, info: { product: 'SQL Server', version: row.version || '', detail: row.edition || '' } };
  } catch (err) {
    await pool.close().catch(() => {});
    const error = friendly(err, t);
    t.close();
    throw error;
  }
}

async function close(state) {
  await state.pool.close().catch(() => {});
  state.tunnel.close();
}

async function databases(state) {
  const r = await state.pool.request().query("SELECT name, database_id FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name");
  // Ids 1-4 are master, tempdb, model and msdb.
  return r.recordset.map((d) => ({ name: d.name, hidden: d.database_id <= 4 }));
}

// Looks the name up rather than trusting it, then quotes what the server returned.
async function checkDatabase(state, database) {
  const r = await state.pool
    .request()
    .input('name', sql.NVarChar(128), String(database || ''))
    .query("SELECT name FROM sys.databases WHERE name = @name AND state_desc = 'ONLINE'");
  if (!r.recordset.length) throw new Error('That database does not exist or is offline.');
  return quoteName(r.recordset[0].name);
}

async function checkTable(state, db, ref) {
  const r = await state.pool
    .request()
    .input('s', sql.NVarChar(128), String((ref && ref.schema) || ''))
    .input('t', sql.NVarChar(128), String((ref && ref.table) || ''))
    .query(`SELECT s.name AS s, t.name AS t FROM ${db}.sys.tables t JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = @s AND t.name = @t`);
  if (!r.recordset.length) throw new Error('That table does not exist.');
  return `${db}.${quoteName(r.recordset[0].s)}.${quoteName(r.recordset[0].t)}`;
}

async function collections(state, database) {
  const db = await checkDatabase(state, database);
  const r = await state.pool.request().query(`SELECT s.name AS schema_name, t.name AS table_name, t.is_ms_shipped, SUM(p.rows) AS row_count
    FROM ${db}.sys.tables t
    JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
    LEFT JOIN ${db}.sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
    GROUP BY s.name, t.name, t.is_ms_shipped
    ORDER BY s.name, t.name`);
  return r.recordset.map((t) => ({
    name: `${t.schema_name}.${t.table_name}`,
    ref: { schema: t.schema_name, table: t.table_name },
    count: Number(t.row_count) || 0,
    hidden: Boolean(t.is_ms_shipped),
  }));
}

async function browse(state, { database, ref, query = '', from = 0, size = 50 } = {}) {
  const text = String(query || '').trim();
  // The read-only screen goes first: it needs no round trip, and a refused query should say why.
  if (text) checkReadOnly(text);
  const db = await checkDatabase(state, database);
  if (text) {
    const tx = new sql.Transaction(state.pool);
    await tx.begin();
    try {
      const request = new sql.Request(tx);
      request.arrayRowMode = true;
      const result = await request.query(`USE ${db}; SET ROWCOUNT ${MAX_QUERY_ROWS + 1}; ${text.replace(/;\s*$/, '')}`);
      const { columns, rows } = table(result);
      const truncated = rows.length > MAX_QUERY_ROWS;
      const shown = truncated ? rows.slice(0, MAX_QUERY_ROWS) : rows;
      return { kind: 'rows', paged: false, total: shown.length, from: 0, size: shown.length, truncated, columns, rows: shown };
    } finally {
      // SET ROWCOUNT outlives the statement on this pooled connection, so it is put back first.
      await new sql.Request(tx).query('SET ROWCOUNT 0').catch(() => {});
      await tx.rollback().catch(() => {});
    }
  }

  const target = await checkTable(state, db, ref);
  const pageSize = Math.max(1, Math.min(Number(size) || 50, 200));
  const start = Math.max(0, Math.floor(Number(from) || 0));
  const count = await state.pool.request().query(`SET ROWCOUNT 0; SELECT COUNT_BIG(*) AS n FROM ${target}`);
  const request = state.pool.request();
  request.arrayRowMode = true;
  const result = await request
    .input('from', sql.BigInt, start)
    .input('size', sql.Int, pageSize)
    .query(`SET ROWCOUNT 0; SELECT * FROM ${target} ORDER BY (SELECT NULL) OFFSET @from ROWS FETCH NEXT @size ROWS ONLY`);
  const { columns, rows } = table(result);
  return {
    kind: 'rows',
    paged: true,
    total: Number(count.recordset[0].n) || 0,
    from: start,
    size: pageSize,
    maxFrom: Number.MAX_SAFE_INTEGER,
    columns,
    rows,
  };
}

async function schema(state, { database, ref } = {}) {
  const db = await checkDatabase(state, database);
  await checkTable(state, db, ref);
  const r = await state.pool
    .request()
    .input('s', sql.NVarChar(128), String(ref.schema))
    .input('t', sql.NVarChar(128), String(ref.table))
    .query(`SELECT COLUMN_NAME AS name, DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS max_length, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_value
      FROM ${db}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t ORDER BY ORDINAL_POSITION`);
  return { columns: r.recordset };
}

module.exports = { levels: 2, open, close, databases, collections, browse, schema, checkReadOnly };
