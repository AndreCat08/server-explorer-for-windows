// Local MCP endpoint that gives the Claude CLI Server Explorer's tools. It listens on 127.0.0.1 only,
// requires a random per-launch token, and each chat gets its own URL so tool calls act on that
// chat's server and approval flow.
const http = require('http');
const crypto = require('crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { TOOL_DEFS } = require('./tools');

const MAX_BODY = 10 * 1024 * 1024;
const token = crypto.randomBytes(32).toString('hex');
const toolboxes = new Map(); // chatId -> toolbox
let portPromise = null;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const match = (req.url || '').match(/^\/mcp\/([\w-]+)$/);
  if (!match || req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  const toolbox = toolboxes.get(match[1]);
  if (!toolbox) {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }

  const body = JSON.parse(await readBody(req));
  const server = new Server({ name: 'server-explorer', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: await toolbox.call(request.params.name, request.params.arguments || {}) }],
  }));
  // Stateless: a fresh server and transport per request, answering with plain JSON.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function start() {
  if (!portPromise) {
    portPromise = new Promise((resolve, reject) => {
      const httpServer = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null }));
        });
      });
      httpServer.on('error', (err) => {
        portPromise = null;
        reject(err);
      });
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port));
    });
  }
  return portPromise;
}

async function endpoint(chatId, toolbox) {
  const port = await start();
  toolboxes.set(chatId, toolbox);
  return { url: `http://127.0.0.1:${port}/mcp/${chatId}`, token };
}

function unregister(chatId) {
  toolboxes.delete(chatId);
}

module.exports = { endpoint, unregister };
