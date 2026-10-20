// Apps opened from Finder get a minimal PATH, so tools installed through nvm or Homebrew (like
// `claude`) aren't found. Read PATH once from the user's login shell.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pathPromise = null;

// Reads PATH from the registry directly (HKCU + HKLM, like Windows itself does when building a new
// process's environment) instead of trusting process.env.PATH, which can be stale if the app has been
// running since before `npm install -g` (or an installer) updated PATH.
function registryPath(hive, key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', hive, '/v', key], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve('');
      const match = String(stdout || '').match(/REG_(?:EXPAND_)?SZ\s+(.*)/);
      resolve(match ? match[1].trim() : '');
    });
  });
}

function expandWindowsEnv(value) {
  return value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);
}

function loginPath() {
  if (!pathPromise) {
    pathPromise = new Promise((resolve) => {
      if (process.platform === 'win32') {
        Promise.all([
          registryPath('HKCU\\Environment', 'Path'),
          registryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'),
        ]).then(([userPath, systemPath]) => {
          const parts = [
            ...(userPath ? expandWindowsEnv(userPath).split(path.delimiter) : []),
            ...(systemPath ? expandWindowsEnv(systemPath).split(path.delimiter) : []),
            ...(process.env.PATH || '').split(path.delimiter),
            process.env.NPM_CONFIG_PREFIX,
            process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'claude-code') : null,
          ].filter(Boolean);
          resolve([...new Set(parts)].join(path.delimiter));
        });
        return;
      }
      const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
      execFile(shell, ['-ilc', 'printf "__SE_PATH__%s__SE_END__" "$PATH"'], { timeout: 15000 }, (_err, stdout) => {
        const match = String(stdout || '').match(/__SE_PATH__(.*)__SE_END__/s);
        const parts = [
          ...(match ? match[1].split(':') : []),
          ...(process.env.PATH || '').split(':'),
          path.join(os.homedir(), '.local/bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ].filter(Boolean);
        resolve([...new Set(parts)].join(':'));
      });
    });
  }
  return pathPromise;
}

const WIN32_BIN_EXTENSIONS = ['', '.cmd', '.exe', '.ps1'];

async function findBinary(name) {
  const dirs = (await loginPath()).split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? WIN32_BIN_EXTENSIONS : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not in this directory.
      }
    }
  }
  return null;
}

// Same search as findBinary, but reports how many directories were checked so callers can surface a
// more useful error when detection fails (e.g. "checked 42 directories" vs. a bare "not found").
async function findBinaryDiagnostics(name) {
  const bin = await findBinary(name);
  const dirs = (await loginPath()).split(path.delimiter).filter(Boolean);
  return { bin, checked: dirs.length };
}

// Resolves a binary honoring a user-supplied override path first. When overridePath is set, PATH
// search is skipped entirely and the override is used as-is if it is an executable file; an invalid
// override is reported distinctly (overrideInvalid) instead of silently falling back to auto-detect,
// so the user finds out the path they typed is wrong rather than wondering why it was ignored.
async function resolveBinary(name, overridePath) {
  const trimmed = (overridePath || '').trim();
  if (trimmed) {
    try {
      fs.accessSync(trimmed, fs.constants.X_OK);
      return { bin: trimmed, overrideInvalid: false };
    } catch {
      return { bin: null, overrideInvalid: true };
    }
  }
  const { bin, checked } = await findBinaryDiagnostics(name);
  return { bin, overrideInvalid: false, checked };
}

async function toolEnv(extra = {}) {
  const env = { ...process.env, PATH: await loginPath(), ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

module.exports = { findBinary, findBinaryDiagnostics, resolveBinary, toolEnv };
