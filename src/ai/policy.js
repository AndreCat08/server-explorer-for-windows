// Security policy for the AI assistant's tools. Pure functions, no I/O.
//
// The command classifier is a safety net against mistakes, not a boundary against a model that
// actively wants around it: a shell string can always hide its intent behind indirection. The real
// boundaries are the mode (which denies whole tools at the dispatcher regardless of the string),
// the human approval on the destructive class, and the local folder containment in tools.js.
// Classification only decides which of those applies.

const MODES = ['readonly', 'normal', 'full'];

// Stopping these would cut the user's own connection. jobs.js already blocks them for UI-driven
// jobs; the AI path reaches the same services through a raw command, so it is checked here too.
const PROTECTED_SERVICES = ['ssh', 'sshd', 'openssh-server'];

// Anything that can't be read literally is treated as highest risk rather than lowest.
const OBFUSCATION = [
  [/\$\(|`/, 'it builds part of the command from another command'],
  [/\beval\b/, 'it uses eval'],
  [/\bbase64\b[^|]*(-d|--decode)|(-d|--decode)[^|]*\bbase64\b/, 'it decodes base64'],
  [/\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/, 'it pipes text into a shell'],
  [/\\x[0-9a-fA-F]{2}|\\0[0-7]{2}/, 'it uses escaped byte sequences'],
  [/\$\{!/, 'it uses variable indirection'],
  // A variable used where the command name belongs hides what actually runs.
  [/(^|[\n;&|]|\b(?:then|else|do)\s)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\$[A-Za-z_{]/, 'it runs a command held in a variable'],
  [/\bxxd\b|\bod\b\s+-|\bprintf\b[^|]*\\/, 'it reconstructs text from encoded bytes'],
];

const DESTRUCTIVE = [
  [/\brm\b[^|;&]*\s-[a-zA-Z]*[rf]/, 'it deletes files recursively or forcibly'],
  [/\bmkfs\b|\bmke2fs\b/, 'it formats a filesystem'],
  [/\bdd\b[^|;&]*\bof=/, 'it writes a raw disk image'],
  [/\bshred\b/, 'it destroys files irrecoverably'],
  [/>\s*\/dev\/(sd|nvme|vd|hd)/, 'it writes directly to a disk device'],
  [/\b(reboot|shutdown|halt|poweroff)\b|\binit\s+[06]\b/, 'it restarts or shuts down the server'],
  // Anchored to the start of a segment: `cat /etc/passwd` reads a file, it does not change accounts.
  [/(^|[\n;&|])\s*(?:sudo\s+)?(userdel|usermod|passwd|chpasswd|adduser|useradd)\b/, 'it changes user accounts or passwords'],
  [/\bchown\b[^|;&]*\s-[a-zA-Z]*R[^|;&]*\s\/(\s|$)/, 'it changes ownership across the filesystem'],
  [/\bchmod\b[^|;&]*\s-[a-zA-Z]*R[^|;&]*\s777/, 'it makes files world-writable recursively'],
  [/\bufw\s+(disable|reset)\b|\biptables\b[^|;&]*\s-F\b|\bnft\s+flush\b/, 'it tears down the firewall'],
  [/\btruncate\b/, 'it truncates files'],
  [/\bdocker\b[^|;&]*\bsystem\s+prune\b|\bdocker\b[^|;&]*\b(rm|rmi)\b[^|;&]*\s-[a-zA-Z]*f/, 'it force-removes Docker resources'],
  [/\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i, 'it drops a database object'],
  [/\bgit\b[^|;&]*\breset\b[^|;&]*--hard/, 'it discards work with git reset --hard'],
  [/:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/, 'it looks like a fork bomb'],
  [/\bmv\b[^|;&]*\s\/(etc|boot|usr|bin|sbin|lib|var)\b/, 'it moves a system directory'],
];

// Read-only verbs. A command counts as `read` only when every segment starts with one of these and
// nothing redirects output into a file.
const READ_VERBS = [
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'find', 'stat', 'file', 'wc', 'du', 'df',
  'ps', 'top', 'htop', 'free', 'uptime', 'uname', 'id', 'whoami', 'hostname', 'date', 'env',
  'journalctl', 'netstat', 'ss', 'lsof', 'which', 'whereis', 'pwd', 'readlink', 'realpath',
  'echo', 'printf', 'sort', 'uniq', 'awk', 'cut', 'tr', 'basename', 'dirname', 'true', 'test',
  'getent', 'locale', 'lsb_release', 'arch', 'nproc', 'lscpu', 'lsblk', 'blkid', 'mount', 'vmstat',
  'iostat', 'ip', 'dig', 'host', 'nslookup', 'ping', 'traceroute', 'tree', 'diff', 'cmp', 'md5sum',
  'sha256sum', 'jq', 'column', 'less', 'more', 'zcat', 'tac', 'nl', 'seq', 'yes',
];

// Multi-word read-only forms, checked before the bare verb list.
const READ_PHRASES = [
  /^systemctl\s+(status|is-active|is-enabled|is-failed|list-units|list-unit-files|show|cat)\b/,
  /^docker\s+(ps|images|logs|inspect|stats|version|info|port|top|diff|history)\b/,
  /^docker\s+compose\s+(ps|logs|config|images|top|version)\b/,
  /^dpkg\s+(-l|-s|--list|--status)\b/,
  /^rpm\s+-q/,
  /^apt\s+list\b/,
  /^apt-cache\s+(show|policy|search)\b/,
  /^curl\s+(-I|--head)\b/,
  /^nginx\s+-[tT]\b/,
  /^apache2ctl\s+-[tS]\b/,
  /^sed\s+-n\b/,
  /^git\s+(status|log|diff|show|branch|remote|config\s+--get)\b/,
  /^npm\s+(ls|list|view|outdated)\b/,
  /^pip\s+(list|show|freeze)\b/,
  /^crontab\s+-l\b/,
  /^ufw\s+status\b/,
  /^firewall-cmd\s+--list/,
  /^command\s+-v\b/,
  /^type\s+/,
];

const SENSITIVE_PATHS = [
  /^\/etc\/(shadow|gshadow)$/,
  /^\/etc\/sudoers(\.d\/.*)?$/,
  /(^|\/)\.ssh\/(id_[^/]*|authorized_keys|known_hosts)$/,
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)credentials$/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  /\.(pem|key|p12|pfx|keystore)$/,
  /^\/root(\/|$)/,
  /^\/var\/lib\/(mysql|postgresql)(\/|$)/,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/,
];

const SYSTEM_PREFIXES = ['/etc', '/boot', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/sys', '/proc', '/var/lib', '/opt/systemd'];

const READ_TOOLS = new Set(['read_server_file', 'list_server_dir', 'read_local_file', 'list_local_dir']);

function splitSegments(cmd) {
  // Good enough for classification: quoting edge cases fall through to the stricter `write` class.
  return cmd
    .split(/\n|;|&&|\|\||\||&/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripEnvPrefix(segment) {
  // `FOO=bar ls` and `sudo ls` still read as their underlying verb.
  return segment
    .replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
    .replace(/^(sudo|env|nice|ionice|time|nohup)\s+(-\S+\s+)*/, '')
    .trim();
}

function touchesProtectedService(cmd) {
  const isProtected = (name) => PROTECTED_SERVICES.includes(String(name).replace(/\.service$/, ''));
  // systemctl stop <name>
  const systemd = cmd.match(/\bsystemctl\s+(?:--\S+\s+)*(stop|disable|mask|kill)\s+(\S+)/);
  if (systemd && isProtected(systemd[2])) return true;
  // service <name> stop  — the name and the verb are the other way round.
  const sysv = cmd.match(/\bservice\s+(\S+)\s+(stop|disable|kill)\b/);
  if (sysv && isProtected(sysv[1])) return true;
  return false;
}

function touchesSshPort(cmd) {
  if (!/\b(ufw|iptables|firewall-cmd|nft)\b/.test(cmd)) return false;
  if (!/\b(deny|reject|drop|delete|remove|--remove-port)\b/.test(cmd)) return false;
  // Only a 22 written as a port counts. A bare \b22\b would also fire on a source address like
  // 10.0.0.22, which is an ordinary rule that has nothing to do with the SSH port.
  return (
    /(^|\s)22(\/(tcp|udp))?(\s|$)/.test(cmd) ||
    /(^|[\s-])(port|dport|sport)[\s=]+22(\s|$)/.test(cmd) ||
    /--remove-port=22\b/.test(cmd)
  );
}

function classifyCommand(cmd) {
  const text = String(cmd || '');
  const reasons = [];

  for (const [pattern, reason] of OBFUSCATION) {
    if (pattern.test(text)) {
      reasons.push(`${reason}, so it can't be checked`);
      return { risk: 'destructive', reasons };
    }
  }

  for (const [pattern, reason] of DESTRUCTIVE) {
    if (pattern.test(text)) reasons.push(reason);
  }
  if (touchesProtectedService(text)) reasons.push('it stops or disables SSH, which would cut the connection');
  if (touchesSshPort(text)) reasons.push('it blocks the SSH port, which would cut the connection');
  if (reasons.length) return { risk: 'destructive', reasons };

  const segments = splitSegments(text);
  const redirects = /(^|[^0-9<>])>{1,2}[^&]/.test(text) || /\btee\b/.test(text);
  const allRead =
    segments.length > 0 &&
    !redirects &&
    segments.every((raw) => {
      const seg = stripEnvPrefix(raw);
      if (READ_PHRASES.some((p) => p.test(seg))) return true;
      const verb = seg.split(/\s+/)[0] || '';
      return READ_VERBS.includes(verb);
    });
  if (allRead) return { risk: 'read', reasons: [] };

  return { risk: 'write', reasons: [] };
}

function normalizePath(p, { home = '/root' } = {}) {
  let out = String(p || '').trim();
  if (out === '~') out = home;
  else if (out.startsWith('~/')) out = `${home}${out.slice(1)}`;
  return out.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function classifyPath(p) {
  const raw = String(p || '');
  const normalized = normalizePath(raw);
  // A remote path containing `..` is itself a reason not to trust the target.
  if (/(^|\/)\.\.(\/|$)/.test(raw)) return 'system';
  if (SENSITIVE_PATHS.some((re) => re.test(normalized))) return 'sensitive';
  if (SYSTEM_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return 'system';
  return 'normal';
}

const allow = () => ({ action: 'allow', warnings: [] });
const ask = (reason, { force = false, warnings = [] } = {}) => ({ action: 'ask', reason, forceAsk: force, warnings });
const deny = (reason) => ({ action: 'deny', reason, warnings: [] });

function decideCommand(mode, input) {
  const { risk, reasons } = classifyCommand(input.command);
  const asRoot = Boolean(input.as_root);
  const why = reasons.length ? reasons.join('; ') : null;

  if (risk === 'destructive') {
    const reason = `this command is destructive (${why})`;
    if (mode === 'readonly') return { ...deny(reason), risk };
    return { ...ask(reason, { force: true, warnings: reasons }), risk };
  }
  if (risk === 'read' && !asRoot) return { ...allow(), risk };
  if (mode === 'readonly') {
    return { ...deny(asRoot ? 'read-only mode does not allow running commands as root' : 'read-only mode only allows commands that inspect the server'), risk };
  }
  return { ...ask(asRoot ? 'this command runs as root' : 'this command changes the server'), risk };
}

function decideWrite(mode, input) {
  const cls = classifyPath(input.path);
  if (mode === 'readonly') return { ...deny('read-only mode does not allow changing files on the server'), risk: 'write', pathClass: cls };
  if (cls === 'sensitive') {
    if (mode === 'normal') {
      return { ...deny(`${input.path} holds credentials or keys; switch to Full mode if you really need to write it`), risk: 'destructive', pathClass: cls };
    }
    return { ...ask(`${input.path} holds credentials or keys`, { force: true }), risk: 'destructive', pathClass: cls };
  }
  if (cls === 'system') {
    return { ...ask(`${input.path} is a system file`, { force: mode === 'normal' }), risk: 'write', pathClass: cls };
  }
  return { ...ask('this writes a file on the server'), risk: 'write', pathClass: cls };
}

function decideRead(mode, input) {
  const target = input.path;
  const cls = classifyPath(target);
  if (cls === 'sensitive') {
    return { ...ask(`${target} may hold credentials or private keys`, { force: true }), risk: 'read', pathClass: cls };
  }
  return { ...allow(), risk: 'read', pathClass: cls };
}

function decideUpload(mode, input) {
  const cls = classifyPath(input.remote_path);
  if (mode === 'readonly') return { ...deny('read-only mode does not allow uploading to the server'), risk: 'write', pathClass: cls };
  if (cls === 'sensitive' || cls === 'system') {
    return { ...ask(`${input.remote_path} is a system or credential location`, { force: mode === 'normal' }), risk: 'write', pathClass: cls };
  }
  return { ...ask('this uploads files to the server'), risk: 'write', pathClass: cls };
}

function decideNote(mode, input) {
  if (!input.on_server) return { ...allow(), risk: 'write' };
  if (mode === 'readonly') return { ...deny('read-only mode does not allow writing a copy of the note on the server'), risk: 'write' };
  return { ...ask('this writes a plain-text copy of the note on the server'), risk: 'write' };
}

// `input` is the model's tool arguments, unvalidated.
function decide({ mode, tool, input = {} }) {
  const active = MODES.includes(mode) ? mode : 'readonly';
  let verdict;
  switch (tool) {
    case 'run_server_command':
      verdict = decideCommand(active, input);
      break;
    case 'write_server_file':
      verdict = decideWrite(active, input);
      break;
    case 'read_server_file':
    case 'list_server_dir':
      verdict = decideRead(active, input);
      break;
    case 'read_local_file':
    case 'list_local_dir':
      // Local access is already confined to attached folders by resolveLocal(); only flag secrets.
      verdict = classifyPath(input.path) === 'sensitive'
        ? { ...ask(`${input.path} may hold credentials or private keys`, { force: true }), risk: 'read' }
        : { ...allow(), risk: 'read' };
      break;
    case 'upload_local_path':
      verdict = decideUpload(active, input);
      break;
    case 'save_note':
      verdict = decideNote(active, input);
      break;
    default:
      verdict = { ...deny(`unknown tool ${tool}`), risk: 'write' };
  }
  return { forceAsk: false, warnings: [], reason: null, ...verdict, mode: active, tool };
}

// Second, independent call site before a command reaches `sh` (see jobs.js). Deliberately thin: it
// re-runs the same classifier, so it catches a bypassed policy layer, not a smarter command string.
function commandGate(cmd, mode) {
  const active = MODES.includes(mode) ? mode : 'readonly';
  const { risk, reasons } = classifyCommand(cmd);
  if (active === 'readonly' && risk !== 'read') {
    return { ok: false, reason: reasons.join('; ') || 'read-only mode only allows commands that inspect the server' };
  }
  return { ok: true };
}

module.exports = {
  MODES,
  PROTECTED_SERVICES,
  READ_TOOLS,
  classifyCommand,
  classifyPath,
  normalizePath,
  decide,
  commandGate,
};
