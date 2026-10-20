// The tools the AI assistant can use. Both providers (Claude CLI over MCP, 9router over function
// calling) get exactly these. Anything that changes the server needs the user's approval, and
// local access is limited to folders the user attached.
const fs = require('fs');
const path = require('path');
const ssh = require('../ssh');
const jobs = require('../jobs');
const notes = require('../notes');
const policy = require('./policy');

const MAX_TOOL_OUTPUT = 20000;
const MAX_LOCAL_READ = 200 * 1024;
const MAX_UPLOAD_FILES = 5000;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.DS_Store', '__pycache__', '.venv']);

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const TOOL_DEFS = [
  {
    name: 'run_server_command',
    description:
      'Run a shell command (or short sh script) on the connected Linux server. The user must approve it first. ' +
      'Runs non-interactively without a TTY, so use -y style flags. Returns the exit code and combined output (truncated). ' +
      'Set as_root for anything that needs root instead of writing sudo.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command or script to run.' },
        explanation: { type: 'string', description: 'One short plain-language sentence telling the user what this does and why.' },
        as_root: { type: 'boolean', description: 'Run with root rights (uses sudo when the login user is not root).' },
      },
      required: ['command', 'explanation'],
    },
  },
  {
    name: 'read_server_file',
    description: 'Read a text file on the server (first 100 KB). No approval needed.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path on the server.' } }, required: ['path'] },
  },
  {
    name: 'list_server_dir',
    description: 'List a directory on the server with types and sizes. No approval needed.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path on the server, or ~ for home.' } }, required: ['path'] },
  },
  {
    name: 'write_server_file',
    description: 'Create or overwrite a text file on the server. The user must approve it. Uses root rights automatically if the file needs them.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path on the server.' },
        content: { type: 'string', description: 'The full new file content.' },
        explanation: { type: 'string', description: 'One short plain-language sentence explaining the change.' },
      },
      required: ['path', 'content', 'explanation'],
    },
  },
  {
    name: 'upload_local_path',
    description:
      "Upload a file or folder from the user's attached local folders to the server. The user must approve it. " +
      'For a folder, its contents are placed inside remote_path (created if missing); node_modules and .git are skipped. ' +
      'For a file, remote_path is the destination file path (or a directory ending in /). The login user needs write access to the destination.',
    inputSchema: {
      type: 'object',
      properties: {
        local_path: { type: 'string', description: 'Absolute path inside an attached folder.' },
        remote_path: { type: 'string', description: 'Absolute destination path on the server.' },
        explanation: { type: 'string', description: 'One short plain-language sentence explaining the upload.' },
      },
      required: ['local_path', 'remote_path', 'explanation'],
    },
  },
  {
    name: 'list_local_dir',
    description: "List a directory inside the folders the user attached from their PC (read-only). Use recursive for a tree up to 3 levels deep.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path inside an attached folder.' },
        recursive: { type: 'boolean', description: 'Include subfolders (up to 3 levels, skipping node_modules and .git).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_local_file',
    description: 'Read a text file inside the attached local folders (first 200 KB, read-only).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path inside an attached folder.' } }, required: ['path'] },
  },
  {
    name: 'save_note',
    description:
      'Save important details about something on the server so the user can find them later in the app, on the item itself. ' +
      'Use this whenever you finish setting something up and it produced information worth keeping: logins, connection strings, ' +
      'ports, URLs, where the config lives, how to start it again. The user must approve it. ' +
      'Saving replaces any existing note for the same item.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'What the note belongs to: container, image, compose, website or service.' },
        key: {
          type: 'string',
          description: 'The item as it appears on the server: container name, repository:tag, Compose project name, domain, or service name.',
        },
        title: { type: 'string', description: 'Short title, for example "Grafana and Kibana logins".' },
        body: { type: 'string', description: 'The details themselves, as plain text or Markdown.' },
        explanation: { type: 'string', description: 'One short plain-language sentence telling the user what is being saved.' },
        on_server: {
          type: 'boolean',
          description: 'Also write a readable copy on the server. That copy is plain text, so leave it off for anything secret.',
        },
      },
      required: ['kind', 'key', 'title', 'body', 'explanation'],
    },
  },
];

function truncate(text, limit = MAX_TOOL_OUTPUT) {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - limit} characters cut ...]\n\n${text.slice(-half)}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// `ask(request)` resolves 'allow' or 'deny'; `askPassword(retry)` resolves a sudo password or null;
// `emit(event)` reports tool activity to the chat UI.
function createToolbox({ serverId, getFolders, getMode, ask, askPassword, emit, audit }) {
  const cancels = new Set();
  let nextActivity = 1;

  function activity(tool, title, detail) {
    const id = `a${nextActivity++}`;
    emit({ type: 'activity', activity: { id, tool, title, detail, status: 'pending' } });
    return {
      update: (patch) => emit({ type: 'activity-update', id, patch }),
      append: (chunk) => emit({ type: 'activity-output', id, chunk }),
    };
  }

  // Runs a job (see jobs.js), retrying with a password when sudo asks for one.
  async function runWithSudo(spec, onData) {
    let password;
    for (;;) {
      let output = '';
      const result = await new Promise((resolve, reject) => {
        jobs
          .startJob(serverId, spec, password, {
            onData: (chunk) => {
              output += chunk;
              onData?.(chunk);
            },
            onExit: resolve,
          })
          .then((handle) => {
            if (handle) cancels.add(handle.cancel);
          }, reject);
      });
      if (result.needPassword) {
        password = await askPassword(Boolean(password));
        if (!password) return { ...result, code: null, cancelled: true, output };
        continue;
      }
      return { ...result, output };
    }
  }

  function localFolders() {
    const folders = getFolders();
    if (!folders.length) throw new Error("No local folders are attached. Ask the user to click 'Attach Folder' and choose the folder you need.");
    return folders;
  }

  function resolveLocal(p) {
    const folders = localFolders();
    const absolute = path.resolve(path.isAbsolute(p) ? p : path.join(folders[0], p));
    let real;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      throw new Error(`Not found on the PC: ${absolute}`);
    }
    if (!folders.some((f) => real === f || real.startsWith(f + path.sep))) {
      throw new Error(`${absolute} is outside the attached folders (${folders.join(', ')}). Ask the user to attach it.`);
    }
    return real;
  }

  // The policy layer already decided allow/ask/deny; handlers only carry the prompt's wording.
  function gate(verdict, request) {
    if (!verdict || verdict.action === 'allow') return Promise.resolve('allow');
    return ask({ ...request, risk: verdict.risk, reason: verdict.reason, warnings: verdict.warnings, forceAsk: verdict.forceAsk });
  }

  // File contents and command output are data the model must not obey. Wrapping them makes the
  // boundary explicit, and stripping the literal tag stops content from forging its own closer.
  function untrusted(source, text) {
    const body = String(text).split('</untrusted-output>').join('<\\/untrusted-output>');
    return `<untrusted-output source=${JSON.stringify(source)}>\n${body}\n</untrusted-output>`;
  }

  const handlers = {
    async run_server_command({ command, explanation, as_root: asRoot }, verdict) {
      if (typeof command !== 'string' || !command.trim()) return 'Error: command is required.';
      const decision = await gate(verdict, { kind: 'command', title: asRoot ? 'Run this as root on the server?' : 'Run this on the server?', code: command, explanation });
      const act = activity('run_server_command', asRoot ? 'Run on server as root' : 'Run on server', command);
      if (decision !== 'allow') {
        act.update({ status: 'denied' });
        return 'The user declined this command. Do not run it; ask the user how they want to proceed.';
      }
      act.update({ status: 'running' });
      const result = await runWithSudo({ kind: 'aiCommand', command, asRoot: Boolean(asRoot), mode: getMode() }, act.append);
      if (result.cancelled) {
        act.update({ status: 'denied' });
        return 'The command was not run because the user did not provide the sudo password.';
      }
      act.update({ status: result.code === 0 ? 'done' : 'error', code: result.code });
      const output = truncate(result.output) || '(no output)';
      return `Exit code: ${result.code ?? 'none (interrupted)'}\n${result.error ? `${result.error}\n` : ''}Output:\n${untrusted(`command: ${command.slice(0, 200)}`, output)}`;
    },

    async read_server_file({ path: file }, verdict) {
      const decision = await gate(verdict, { kind: 'read', title: `Let the assistant read ${file}?`, code: file, explanation: verdict?.reason || 'The assistant wants to read this file.' });
      const act = activity('read_server_file', 'Read server file', file);
      if (decision !== 'allow') {
        act.update({ status: 'denied' });
        return 'The user declined this read.';
      }
      try {
        const res = await ssh.readText(serverId, file);
        if (res.binary) throw new Error('This is a binary file, not text.');
        if (res.tooLarge) throw new Error(`File is ${fmtBytes(res.size)}; too large. Use run_server_command with head/tail/grep instead.`);
        act.update({ status: 'done' });
        return untrusted(file, truncate(res.text, 100 * 1024) || '(empty file)');
      } catch (err) {
        act.update({ status: 'error', output: err.message });
        return `Error: ${err.message}`;
      }
    },

    async list_server_dir({ path: dir }, verdict) {
      const decision = await gate(verdict, { kind: 'read', title: `Let the assistant list ${dir}?`, code: dir, explanation: verdict?.reason || 'The assistant wants to list this folder.' });
      const act = activity('list_server_dir', 'List server folder', dir);
      if (decision !== 'allow') {
        act.update({ status: 'denied' });
        return 'The user declined this listing.';
      }
      try {
        const home = await ssh.home(serverId);
        const target = dir === '~' || !dir ? home : dir.startsWith('~/') ? `${home}${dir.slice(1)}` : dir;
        const res = await ssh.listDir(serverId, target);
        act.update({ status: 'done' });
        const lines = res.entries
          .sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name))
          .slice(0, 500)
          .map((e) => `${e.isDir ? 'dir ' : e.isLink ? 'link' : 'file'}  ${e.name}${e.isDir ? '/' : `  (${fmtBytes(e.size)})`}  ${e.perms} ${e.owner}`);
        return `${res.path} (${res.entries.length} entries)\n${lines.join('\n') || '(empty)'}`;
      } catch (err) {
        act.update({ status: 'error', output: err.message });
        return `Error: ${err.message}`;
      }
    },

    async write_server_file({ path: file, content, explanation }, verdict) {
      if (typeof file !== 'string' || !file.startsWith('/')) return 'Error: path must be an absolute path.';
      if (typeof content !== 'string') return 'Error: content is required.';
      const preview = content.length > 6000 ? `${content.slice(0, 6000)}\n… (${content.length - 6000} more characters)` : content;
      // This write silently falls back to sudo below, so find out first and say so in the prompt.
      let needsRoot = false;
      try {
        const probe = await ssh.exec(serverId, `test -w ${q(file)} || { test ! -e ${q(file)} && test -w ${q(path.posix.dirname(file))}; }`, null, 20000);
        needsRoot = probe.code !== 0;
      } catch {
        // If the probe itself fails, fall back to the old behaviour rather than blocking the write.
      }
      const warnings = [...(verdict?.warnings || [])];
      if (needsRoot) warnings.push('This file needs root rights, so it will be written with sudo.');
      const decision = await gate(verdict && { ...verdict, warnings }, {
        kind: 'write',
        title: needsRoot ? `Write ${file} as root?` : `Write ${file}?`,
        code: preview,
        explanation,
      });
      const act = activity('write_server_file', 'Write server file', file);
      if (decision !== 'allow') {
        act.update({ status: 'denied' });
        return 'The user declined this file change.';
      }
      act.update({ status: 'running' });
      try {
        try {
          await ssh.writeText(serverId, file, content);
        } catch (err) {
          if (!/permission denied/i.test(err.message)) throw err;
          const tmp = `/tmp/.se-edit-${require('crypto').randomUUID()}`;
          await ssh.writeText(serverId, tmp, content, 0o600);
          const result = await runWithSudo({ kind: 'writeFile', tmp, target: file });
          if (result.code !== 0) {
            await ssh.remove(serverId, tmp, false).catch(() => {});
            throw new Error(result.error || result.output.trim() || 'Could not write the file with root rights.');
          }
        }
        act.update({ status: 'done' });
        return `Wrote ${fmtBytes(Buffer.byteLength(content))} to ${file}.`;
      } catch (err) {
        act.update({ status: 'error', output: err.message });
        return `Error: ${err.message}`;
      }
    },

    async upload_local_path({ local_path: localPath, remote_path: remotePath, explanation }, verdict) {
      if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) return 'Error: remote_path must be an absolute path.';
      let source;
      try {
        source = resolveLocal(localPath);
      } catch (err) {
        return `Error: ${err.message}`;
      }
      const stat = fs.statSync(source);
      const files = [];
      let total = 0;
      if (stat.isDirectory()) {
        const walk = (dir, rel) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(full, relPath);
            else if (entry.isFile()) {
              const size = fs.statSync(full).size;
              files.push({ full, rel: relPath, size });
              total += size;
              if (files.length > MAX_UPLOAD_FILES || total > MAX_UPLOAD_BYTES) throw new Error('Folder is too big to upload (over 5000 files or 1 GB).');
            }
          }
        };
        try {
          walk(source, '');
        } catch (err) {
          return `Error: ${err.message}`;
        }
      } else {
        files.push({ full: source, rel: path.basename(source), size: stat.size });
        total = stat.size;
      }

      const destFor = (f) => {
        if (stat.isDirectory()) return path.posix.join(remotePath, f.rel);
        return remotePath.endsWith('/') ? path.posix.join(remotePath, f.rel) : remotePath;
      };
      const listing = files.slice(0, 40).map((f) => `${f.rel}  (${fmtBytes(f.size)})`).join('\n');
      const decision = await gate(verdict, {
        kind: 'upload',
        title: `Upload ${files.length} file${files.length === 1 ? '' : 's'} (${fmtBytes(total)}) to ${remotePath}?`,
        code: `From your PC: ${source}\nTo the server: ${remotePath}\n\n${listing}${files.length > 40 ? `\n… and ${files.length - 40} more` : ''}`,
        explanation,
      });
      const act = activity('upload_local_path', 'Upload to server', `${source} → ${remotePath}`);
      if (decision !== 'allow') {
        act.update({ status: 'denied' });
        return 'The user declined this upload.';
      }
      act.update({ status: 'running' });
      try {
        const dirs = [...new Set(files.map((f) => path.posix.dirname(destFor(f))))];
        const mk = await ssh.exec(serverId, `mkdir -p -- ${dirs.map(q).join(' ')}`, null, 60000);
        if (mk.code !== 0) {
          throw new Error(`${mk.stderr.trim()}. Create the folder first with run_server_command (as_root, then chown it to the login user), or upload into the user's home folder.`);
        }
        let done = 0;
        for (const f of files) {
          await ssh.uploadFile(serverId, f.full, destFor(f));
          done++;
          if (done % 10 === 0 || done === files.length) act.append(`Uploaded ${done}/${files.length}\n`);
        }
        act.update({ status: 'done' });
        return `Uploaded ${files.length} file(s), ${fmtBytes(total)}, to ${remotePath}.`;
      } catch (err) {
        act.update({ status: 'error', output: err.message });
        return `Error: ${err.message}`;
      }
    },

    async list_local_dir({ path: dir, recursive }, verdict) {
      const decision = await gate(verdict, { kind: 'read', title: `Let the assistant list ${dir}?`, code: dir, explanation: verdict?.reason || 'The assistant wants to list this local folder.' });
      const act = activity('list_local_dir', 'Look at local folder', dir);
      if (decision !== 'allow') {
        act.update({ status: 'denied' });
        return 'The user declined this listing.';
      }
      try {
        const root = resolveLocal(dir);
        const lines = [];
        const walk = (current, rel, depth) => {
          for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (lines.length >= 400) return;
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
              lines.push(`${relPath}/${SKIP_DIRS.has(entry.name) ? '  (skipped)' : ''}`);
              if (recursive && depth < 3 && !SKIP_DIRS.has(entry.name)) walk(full, relPath, depth + 1);
            } else {
              lines.push(`${relPath}  (${fmtBytes(fs.statSync(full).size)})`);
            }
          }
        };
        walk(root, '', 1);
        act.update({ status: 'done' });
        return `${root}\n${lines.join('\n') || '(empty)'}${lines.length >= 400 ? '\n… (listing cut at 400 entries)' : ''}`;
      } catch (err) {
        act.update({ status: 'error', output: err.message });
        return `Error: ${err.message}`;
      }
    },

    async read_local_file({ path: file }, verdict) {
      const decision = await gate(verdict, { kind: 'read', title: `Let the assistant read ${file}?`, code: file, explanation: verdict?.reason || 'The assistant wants to read this local file.' });
      const act = activity('read_local_file', 'Read local file', file);
      if (decision !== 'allow') {
        act.update({ status: 'denied' });
        return 'The user declined this read.';
      }
      try {
        const real = resolveLocal(file);
        const stat = fs.statSync(real);
        if (!stat.isFile()) throw new Error('Not a file.');
        const fd = fs.openSync(real, 'r');
        const buf = Buffer.alloc(Math.min(stat.size, MAX_LOCAL_READ));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        if (buf.subarray(0, 8000).includes(0)) throw new Error('This is a binary file, not text.');
        act.update({ status: 'done' });
        const text = buf.toString('utf8') + (stat.size > MAX_LOCAL_READ ? `\n… (file is ${fmtBytes(stat.size)}; only the first 200 KB is shown)` : '');
        return untrusted(real, text);
      } catch (err) {
        act.update({ status: 'error', output: err.message });
        return `Error: ${err.message}`;
      }
    },

    async save_note({ kind, key, title, body, explanation, on_server: onServer }, verdict) {
      if (!notes.KINDS.includes(kind)) return `Error: kind must be one of ${notes.KINDS.join(', ')}.`;
      if (typeof key !== 'string' || !key.trim()) return 'Error: key is required (the name of the item this belongs to).';
      if (typeof title !== 'string' || !title.trim()) return 'Error: title is required.';
      if (typeof body !== 'string' || !body.trim()) return 'Error: body is required.';
      const preview = `${title}\n\n${body}`;
      const decision = await gate(verdict, {
        kind: 'write',
        title: onServer ? `Save info for ${kind} "${key}" (also in plain text on the server)?` : `Save info for ${kind} "${key}"?`,
        code: preview.length > 6000 ? `${preview.slice(0, 6000)}\n… (${preview.length - 6000} more characters)` : preview,
        explanation,
      });
      const act = activity('save_note', 'Save info', `${kind}: ${key}`);
      if (decision !== 'allow') {
        act.update({ status: 'denied' });
        return 'The user declined saving this note.';
      }
      act.update({ status: 'running' });
      try {
        const saved = await notes.save(serverId, { kind, key, title, body, onServer: Boolean(onServer) });
        act.update({ status: 'done' });
        return saved.serverError
          ? `Saved on the user's PC, but the copy on the server failed: ${saved.serverError}`
          : `Saved. The user can read it from the Info button on ${kind} "${key}".`;
      } catch (err) {
        act.update({ status: 'error', output: err.message });
        return `Error: ${err.message}`;
      }
    },
  };

  return {
    // Every tool call from every provider passes through here, so the policy check belongs here
    // rather than in the individual handlers.
    async call(name, input) {
      const handler = handlers[name];
      if (!handler) return `Error: unknown tool ${name}`;
      if (!ssh.isConnected(serverId) && name.includes('server')) return 'Error: the server is not connected. Ask the user to reconnect.';
      const args = input || {};
      const mode = getMode();
      const verdict = policy.decide({ mode, tool: name, input: args });
      audit({ tool: name, mode, risk: verdict.risk, action: verdict.action, input: args });
      if (verdict.action === 'deny') {
        activity(name, 'Blocked by security mode', verdict.reason).update({ status: 'denied' });
        return `Blocked: ${verdict.reason}. The user's security mode is "${mode}". Do not retry this or look for another way around it — tell the user what you wanted to do and that they can change the mode in the AI toolbar if they want it.`;
      }
      try {
        return await handler(args, verdict);
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
    cancelAll() {
      for (const cancel of cancels) cancel();
      cancels.clear();
    },
  };
}

module.exports = { TOOL_DEFS, createToolbox };
