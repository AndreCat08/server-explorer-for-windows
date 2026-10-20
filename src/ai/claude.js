// Claude CLI provider: one headless `claude -p` run per message, resumed by session id. Its built-in
// tools are turned off; the only tools are Server Explorer's own (served over MCP), so every
// action goes through the app's approval flow.
const { spawn, execFile } = require('child_process');
const shellenv = require('../shellenv');

async function detect(overridePath) {
  const { bin, overrideInvalid, checked } = await shellenv.resolveBinary('claude', overridePath);
  if (!bin) return { available: false, overrideInvalid, checked, path: overrideInvalid ? overridePath : undefined };
  const env = await shellenv.toolEnv();
  let cmd;
  try {
    cmd = await shellenv.spawnable(bin, ['--version']);
  } catch (err) {
    return { available: false, path: bin, error: err.message };
  }
  return new Promise((resolve) => {
    execFile(cmd[0], cmd[1], { env, timeout: 20000, windowsHide: true }, (err, stdout) => {
      resolve(err ? { available: false, path: bin, error: err.message } : { available: true, path: bin, version: stdout.trim() });
    });
  });
}

async function runTurn({ prompt, sessionId, model, systemPrompt, mcpUrl, mcpToken, cwd, binPath, onTextStart, onText, signal }) {
  const { bin, overrideInvalid } = await shellenv.resolveBinary('claude', binPath);
  if (!bin) {
    throw new Error(
      overrideInvalid
        ? `The Claude CLI path you set (${binPath}) isn't a valid executable. Check it in Claude CLI settings.`
        : 'The Claude CLI was not found. Install it with: npm install -g @anthropic-ai/claude-code'
    );
  }
  const env = await shellenv.toolEnv({ MCP_TOOL_TIMEOUT: '3600000', MAX_MCP_OUTPUT_TOKENS: '60000' });
  const mcpConfig = { mcpServers: { 'server-explorer': { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } } } };
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(mcpConfig),
    '--allowedTools', 'mcp__server-explorer',
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'user',
    '--append-system-prompt', systemPrompt,
  ];
  if (model && model !== 'default') args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);

  const [cmd, cmdArgs] = await shellenv.spawnable(bin, args);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let currentSession = sessionId;
    let buffer = '';
    let stderr = '';
    let result = null;
    // On Windows kill() only ends the top process; taskkill /T takes its children with it.
    const onAbort = () =>
      process.platform === 'win32' && child.pid
        ? execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
        : child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });

    const handle = (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.session_id) currentSession = msg.session_id;
      if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
        const ev = msg.event || {};
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') onTextStart();
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') onText(ev.delta.text);
      } else if (msg.type === 'result') {
        result = msg;
      }
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handle(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return resolve({ sessionId: currentSession, aborted: true });
      if (result && !result.is_error) return resolve({ sessionId: currentSession });
      const detail =
        (result && (result.result || (result.errors || []).join('; '))) ||
        stderr.trim().split('\n').slice(-3).join(' ') ||
        `The Claude CLI exited with code ${code}.`;
      return reject(Object.assign(new Error(detail), { sessionId: currentSession }));
    });
    child.stdin.end(prompt);
  });
}

module.exports = { detect, runTurn };
