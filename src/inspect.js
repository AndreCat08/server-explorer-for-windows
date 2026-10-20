// Remote inspection: POSIX sh scripts piped to `sh -s` on the server, plus parsers for their output.
// Scripts go through stdin so they work no matter what the user's login shell is.
const { runScript } = require('./ssh');
const { CATALOG } = require('./install');

// Make tools installed in common non-login locations (nvm, snap, /usr/local) visible.
const ENV_PRELUDE = `
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/snap/bin:$HOME/.local/bin:$HOME/bin:$HOME/.bun/bin:$HOME/.deno/bin:$HOME/go/bin:/usr/local/go/bin"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
has() { command -v "$1" >/dev/null 2>&1; }
`;

function sections(stdout) {
  const out = {};
  let current = null;
  for (const line of stdout.split('\n')) {
    const m = line.match(/^@@(\w+)@@$/);
    if (m) {
      current = m[1];
      out[current] = [];
    } else if (current) {
      out[current].push(line);
    }
  }
  for (const k of Object.keys(out)) {
    while (out[k].length && out[k][out[k].length - 1] === '') out[k].pop();
  }
  return out;
}

// ---------- Overview ----------

const OVERVIEW_SCRIPT = `${ENV_PRELUDE}
echo @@info@@
echo "hostname=$(hostname 2>/dev/null)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=$PRETTY_NAME"; else echo "os=$(uname -s)"; fi
echo "kernel=$(uname -r)"
echo "arch=$(uname -m)"
echo "uptime=$(uptime -p 2>/dev/null || uptime)"
echo "boot=$(uptime -s 2>/dev/null)"
echo "cpus=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
cpumodel=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2)
[ -z "$cpumodel" ] && cpumodel=$(lscpu 2>/dev/null | grep -m1 'Model name' | cut -d: -f2)
echo "cpumodel=$(echo $cpumodel)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
echo "ips=$(hostname -I 2>/dev/null)"
echo "user=$(id -un)"
echo "users=$(who 2>/dev/null | wc -l | tr -d ' ')"
echo "procs=$(ps -e 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')"
echo @@mem@@
cat /proc/meminfo 2>/dev/null
echo @@disk@@
df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null || df -P -k 2>/dev/null
`;

async function overview(serverId) {
  const res = await runScript(serverId, OVERVIEW_SCRIPT);
  const s = sections(res.stdout);

  const info = {};
  for (const line of s.info || []) {
    const i = line.indexOf('=');
    if (i > 0) info[line.slice(0, i)] = line.slice(i + 1).trim();
  }

  const meminfo = {};
  for (const line of s.mem || []) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) meminfo[m[1]] = Number(m[2]) * 1024;
  }
  const memory = meminfo.MemTotal
    ? {
        total: meminfo.MemTotal,
        used: meminfo.MemTotal - (meminfo.MemAvailable ?? meminfo.MemFree),
        swapTotal: meminfo.SwapTotal || 0,
        swapUsed: (meminfo.SwapTotal || 0) - (meminfo.SwapFree || 0),
      }
    : null;

  const disks = [];
  for (const line of (s.disk || []).slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 6) continue;
    disks.push({
      filesystem: p[0],
      total: Number(p[1]) * 1024,
      used: Number(p[2]) * 1024,
      available: Number(p[3]) * 1024,
      mount: p.slice(5).join(' '),
    });
  }

  return {
    hostname: info.hostname,
    os: info.os,
    kernel: info.kernel,
    arch: info.arch,
    uptime: info.uptime,
    bootTime: info.boot,
    cpus: Number(info.cpus) || null,
    cpuModel: info.cpumodel,
    load: info.load ? info.load.split(' ').map(Number) : null,
    ips: info.ips ? info.ips.split(/\s+/).filter(Boolean) : [],
    user: info.user,
    loggedInUsers: Number(info.users) || 0,
    processCount: Number(info.procs) || 0,
    memory,
    disks,
  };
}

// ---------- Installed apps ----------

// Well-known software: [display name, binary, version command, category]
const KNOWN_SOFTWARE = [
  ['Nginx', 'nginx', 'nginx -v', 'Web server'],
  ['Apache', 'apache2', 'apache2 -v', 'Web server'],
  ['Apache (httpd)', 'httpd', 'httpd -v', 'Web server'],
  ['Caddy', 'caddy', 'caddy version', 'Web server'],
  ['Traefik', 'traefik', 'traefik version', 'Web server'],
  ['HAProxy', 'haproxy', 'haproxy -v', 'Web server'],
  ['Docker', 'docker', 'docker --version', 'Containers'],
  ['Docker Compose', 'docker-compose', 'docker-compose --version', 'Containers'],
  ['Podman', 'podman', 'podman --version', 'Containers'],
  ['kubectl', 'kubectl', 'kubectl version --client', 'Containers'],
  ['Node.js', 'node', 'node --version', 'Runtime'],
  ['npm', 'npm', 'npm --version', 'Runtime'],
  ['Yarn', 'yarn', 'yarn --version', 'Runtime'],
  ['pnpm', 'pnpm', 'pnpm --version', 'Runtime'],
  ['PM2', 'pm2', 'true', 'Runtime'], // `pm2 --version` can spawn the PM2 daemon
  ['Bun', 'bun', 'bun --version', 'Runtime'],
  ['Deno', 'deno', 'deno --version', 'Runtime'],
  ['Python 3', 'python3', 'python3 --version', 'Runtime'],
  ['pip', 'pip3', 'pip3 --version', 'Runtime'],
  ['PHP', 'php', 'php -v', 'Runtime'],
  ['Composer', 'composer', 'composer --version --no-ansi', 'Runtime'],
  ['Java', 'java', 'java -version', 'Runtime'],
  ['Go', 'go', 'go version', 'Runtime'],
  ['Ruby', 'ruby', 'ruby --version', 'Runtime'],
  ['Rust', 'rustc', 'rustc --version', 'Runtime'],
  ['.NET', 'dotnet', 'dotnet --version', 'Runtime'],
  ['MySQL', 'mysql', 'mysql --version', 'Database'],
  ['MariaDB', 'mariadb', 'mariadb --version', 'Database'],
  ['PostgreSQL', 'psql', 'psql --version', 'Database'],
  ['Redis', 'redis-server', 'redis-server --version', 'Database'],
  ['MongoDB', 'mongod', 'mongod --version', 'Database'],
  ['SQLite', 'sqlite3', 'sqlite3 --version', 'Database'],
  ['Git', 'git', 'git --version', 'Tools'],
  ['Certbot', 'certbot', 'certbot --version', 'Tools'],
  ['UFW firewall', 'ufw', 'ufw version', 'Tools'],
  ['Fail2ban', 'fail2ban-client', 'fail2ban-client --version', 'Tools'],
  ['Supervisor', 'supervisord', 'supervisord --version', 'Tools'],
  ['curl', 'curl', 'curl --version', 'Tools'],
  ['OpenSSH', 'ssh', 'ssh -V', 'Tools'],
  ['htop', 'htop', 'htop --version', 'Tools'],
];

function appsScript() {
  const known = KNOWN_SOFTWARE.map(
    ([, bin, cmd]) =>
      `if has ${bin}; then printf '%s\\t%s\\t%s\\n' ${bin} "$(command -v ${bin})" "$(runv ${cmd} 2>&1 | grep -v '^\\s*$' | head -n1)"; fi`
  ).join('\n');

  return `${ENV_PRELUDE}
runv() { if has timeout; then timeout 5 "$@"; else "$@"; fi; }
echo @@known@@
${known}
echo @@packages@@
if has dpkg-query; then
  echo "manager=apt (dpkg)"
  dpkg-query -W -f='\${db:Status-Abbrev}\\t\${Package}\\t\${Version}\\t\${Installed-Size}\\t\${binary:Summary}\\n' 2>/dev/null | grep '^ii' | cut -f2-
elif has rpm; then
  echo "manager=rpm"
  rpm -qa --queryformat '%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{SIZE}\\t%{SUMMARY}\\n' 2>/dev/null
elif has apk; then
  echo "manager=apk"
  apk info -v 2>/dev/null
elif has pacman; then
  echo "manager=pacman"
  pacman -Q 2>/dev/null
fi
echo @@snap@@
has snap && snap list 2>/dev/null | tail -n +2
echo @@pm2@@
# only query PM2 when its daemon is already running (pm2 commands otherwise start it)
[ -f "$HOME/.pm2/pm2.pid" ] && kill -0 "$(cat "$HOME/.pm2/pm2.pid")" 2>/dev/null && has pm2 && runv pm2 jlist 2>/dev/null | grep '^\\['
echo @@catalog@@
${CATALOG.map((c) => `if ${c.detect || `has ${c.bin}`}; then echo ${c.id}; fi`).join('\n')}
echo @@access@@
if [ "$(id -u)" = 0 ]; then echo root; elif has sudo; then if sudo -n true 2>/dev/null; then echo nopasswd; else echo password; fi; else echo none; fi
echo @@end@@
`;
}

function parsePackages(lines) {
  if (!lines || !lines.length) return { manager: null, list: [] };
  const manager = lines[0].startsWith('manager=') ? lines[0].slice(8) : null;
  const list = [];
  for (const line of lines.slice(manager ? 1 : 0)) {
    if (!line.trim()) continue;
    if (manager === 'apt (dpkg)') {
      const [name, version, size, description] = line.split('\t');
      list.push({ name, version, size: Number(size) * 1024 || null, description });
    } else if (manager === 'rpm') {
      const [name, version, size, description] = line.split('\t');
      list.push({ name, version, size: Number(size) || null, description });
    } else if (manager === 'apk') {
      const m = line.match(/^(.+)-(\d[^-]*-r\d+)$/);
      list.push(m ? { name: m[1], version: m[2] } : { name: line, version: '' });
    } else if (manager === 'pacman') {
      const [name, version] = line.split(/\s+/);
      list.push({ name, version });
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { manager, list };
}

async function apps(serverId) {
  const res = await runScript(serverId, appsScript(), 120000);
  const s = sections(res.stdout);
  const byBin = new Map(KNOWN_SOFTWARE.map((k) => [k[1], k]));

  const detected = [];
  for (const line of s.known || []) {
    const [bin, binPath, versionLine = ''] = line.split('\t');
    const meta = byBin.get(bin);
    if (!meta) continue;
    detected.push({ name: meta[0], bin, category: meta[3], path: binPath, version: extractVersion(versionLine), raw: versionLine });
  }

  const snaps = (s.snap || [])
    .filter((l) => l.trim())
    .map((l) => {
      const [name, version, rev, tracking, publisher] = l.trim().split(/\s+/);
      return { name, version, rev, tracking, publisher };
    });

  let pm2 = [];
  const pm2Raw = (s.pm2 || []).join('\n').trim();
  if (pm2Raw) {
    try {
      pm2 = JSON.parse(pm2Raw).map((p) => ({
        name: p.name,
        id: p.pm_id,
        status: p.pm2_env?.status,
        cpu: p.monit?.cpu,
        memory: p.monit?.memory,
        restarts: p.pm2_env?.restart_time,
        cwd: p.pm2_env?.pm_cwd,
        script: p.pm2_env?.pm_exec_path,
        uptime: p.pm2_env?.pm_uptime,
      }));
    } catch {
      pm2 = [];
    }
  }

  const found = new Set((s.catalog || []).map((l) => l.trim()).filter(Boolean));
  const versionByBin = new Map(detected.map((x) => [x.bin, x.version]));
  const catalog = CATALOG.map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category,
    description: c.description,
    bin: c.bin,
    installed: found.has(c.id),
    version: found.has(c.id) ? versionByBin.get(c.bin) || '' : '',
    removable: !!c.remove,
    note: c.note || '',
    keepsData: c.keepsData || '',
  }));
  // root | nopasswd | password | none — whether this login can install software.
  const access = { mode: (s.access || [])[0] || 'none' };

  return { detected, packages: parsePackages(s.packages), snaps, pm2, catalog, access };
}

function extractVersion(line) {
  const m = line.match(/v?(\d+(?:\.\d+)+(?:[-+~][\w.]+)?)/);
  return m ? m[1] : line.trim().slice(0, 60);
}

// ---------- Services ----------

const SERVICES_SCRIPT = `${ENV_PRELUDE}
if has systemctl && [ -d /run/systemd/system ]; then
  echo @@systemd@@
  systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null
  echo @@enabled@@
  systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null
else
  echo @@other@@
  if has service; then service --status-all 2>&1; elif has rc-status; then rc-status -a 2>&1; fi
fi
`;

async function services(serverId) {
  const res = await runScript(serverId, SERVICES_SCRIPT);
  const s = sections(res.stdout);
  if (s.systemd) {
    const enabled = new Map();
    for (const line of s.enabled || []) {
      const [unit, state] = line.trim().split(/\s+/);
      if (unit) enabled.set(unit, state);
    }
    const list = [];
    for (const line of s.systemd) {
      const p = line.trim().split(/\s+/);
      if (p.length < 4 || !p[0].endsWith('.service')) continue;
      list.push({
        name: p[0].replace(/\.service$/, ''),
        load: p[1],
        active: p[2],
        sub: p[3],
        description: p.slice(4).join(' '),
        enabled: enabled.get(p[0]) || '',
      });
    }
    return { system: 'systemd', list };
  }
  const list = (s.other || [])
    .map((line) => {
      const m = line.match(/^\s*\[\s*([+-?])\s*\]\s+(.+)$/);
      if (!m) return null;
      const active = m[1] === '+' ? 'active' : m[1] === '-' ? 'inactive' : 'unknown';
      return { name: m[2].trim(), active, sub: active === 'active' ? 'running' : 'dead', description: '', load: '', enabled: '' };
    })
    .filter(Boolean);
  return { system: 'sysvinit', list };
}

// ---------- Docker ----------

const DOCKER_SCRIPT = `${ENV_PRELUDE}
if ! has docker; then echo @@missing@@; exit 0; fi
echo @@containers@@
docker ps -a --no-trunc --format '{{json .}}' 2>&1
echo @@images@@
docker images --format '{{json .}}' 2>&1
echo @@compose@@
docker compose ls -a --format json 2>/dev/null
`;

function parseJsonLines(lines) {
  const items = [];
  let error = '';
  for (const line of lines || []) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      error += line + '\n';
    }
  }
  return { items, error: error.trim() };
}

async function docker(serverId) {
  const res = await runScript(serverId, DOCKER_SCRIPT);
  const s = sections(res.stdout);
  if (s.missing) return { installed: false };

  const containers = parseJsonLines(s.containers);
  const images = parseJsonLines(s.images);
  let compose = [];
  try {
    compose = JSON.parse((s.compose || []).join('') || '[]');
  } catch {
    compose = [];
  }
  const error = containers.error || images.error;
  return {
    installed: true,
    error: error ? explainDockerError(error) : '',
    containers: containers.items.map((c) => ({
      id: c.ID,
      name: c.Names,
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Ports,
      created: c.CreatedAt,
      command: c.Command,
    })),
    images: images.items.map((i) => ({
      repository: i.Repository,
      tag: i.Tag,
      id: i.ID,
      size: i.Size,
      created: i.CreatedSince,
    })),
    compose: compose.map((p) => ({ name: p.Name, status: p.Status, config: p.ConfigFiles })),
  };
}

function explainDockerError(text) {
  if (/permission denied/i.test(text)) {
    return 'Docker is installed, but this user may not access it. Add the user to the "docker" group (sudo usermod -aG docker $USER), then reconnect.';
  }
  return text;
}

// ---------- Listening ports ----------

const PORTS_SCRIPT = `${ENV_PRELUDE}
if has ss; then echo @@ss@@; ss -tulnpH 2>/dev/null || ss -tuln 2>/dev/null | tail -n +2
elif has netstat; then echo @@netstat@@; netstat -tulnp 2>/dev/null | tail -n +3
fi
echo @@firewall@@
if has ufw; then echo tool=ufw; ufw status 2>&1
elif has firewall-cmd; then echo tool=firewalld; echo "state=$(firewall-cmd --state 2>&1)"; firewall-cmd --list-ports 2>&1
fi
echo @@fwadded@@
has ufw && ufw show added 2>&1
echo @@fwrich@@
has firewall-cmd && firewall-cmd --list-rich-rules 2>&1
`;

async function ports(serverId) {
  const res = await runScript(serverId, PORTS_SCRIPT);
  const s = sections(res.stdout);
  const list = [];
  if (s.ss) {
    for (const line of s.ss) {
      const p = line.trim().split(/\s+/);
      if (p.length < 5) continue;
      const { address, port } = splitAddress(p[4]);
      const procField = p.slice(6).join(' ');
      const procs = [...procField.matchAll(/\("([^"]+)",pid=(\d+)/g)].map((m) => ({ name: m[1], pid: Number(m[2]) }));
      list.push({ protocol: p[0], state: p[1], address, port, process: procs[0]?.name || '', pid: procs[0]?.pid || null });
    }
  } else if (s.netstat) {
    for (const line of s.netstat) {
      const p = line.trim().split(/\s+/);
      if (p.length < 4) continue;
      const { address, port } = splitAddress(p[3]);
      const last = p[p.length - 1];
      const m = last.match(/^(\d+)\/(.+)$/);
      list.push({ protocol: p[0], state: p[5] && !m ? p[5] : 'LISTEN', address, port, process: m ? m[2] : '', pid: m ? Number(m[1]) : null });
    }
  }
  const seen = new Set();
  const unique = list.filter((x) => {
    const key = `${x.protocol}|${x.address}|${x.port}|${x.pid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.port - b.port);
  return { list: unique, limited: unique.some((x) => !x.process), firewall: parseFirewall(s.firewall, s.fwadded, s.fwrich) };
}

// Which ports the server firewall allows. Listing rules needs root, so an access error means "unknown".
function parseFirewall(lines, added, rich) {
  if (!lines || !lines.length) return { tool: null, active: false, readable: true, rules: [] };
  const tool = (lines[0].match(/^tool=(\w+)$/) || [])[1] || null;
  const body = lines.slice(1);
  const text = body.join('\n');
  if (!tool) return { tool: null, active: false, readable: true, rules: [] };
  if (/need to be root|Permission denied|not authorized|Authorization failed/i.test(text)) {
    return { tool, active: false, readable: false, rules: [] };
  }
  const rules = [];
  if (tool === 'ufw') {
    for (const line of body) {
      if (/\(v6\)/.test(line)) continue;
      const m = line.match(/^(\d{1,5})(?::(\d{1,5}))?\/(tcp|udp)\s+(ALLOW|DENY|REJECT|LIMIT)\b\s*(?:IN)?\s*(.*)$/i);
      if (!m) continue;
      rules.push({
        port: Number(m[1]),
        endPort: m[2] ? Number(m[2]) : null,
        protocol: m[3].toLowerCase(),
        action: m[4].toUpperCase(),
        ...splitFrom(m[5]),
      });
    }
    const addedRules = [];
    for (const line of added || []) {
      // Both plain and source-bound forms, since `ufw show added` is all there is while ufw is off.
      const plain = line.match(/^ufw\s+(allow|deny|reject|limit)\s+(\d{1,5})(?::(\d{1,5}))?\/(tcp|udp)\s*(?:comment\s+(.*))?$/i);
      const bound = line.match(/^ufw\s+(allow|deny|reject|limit)\s+from\s+(\S+)\s+to\s+any\s+port\s+(\d{1,5})(?::(\d{1,5}))?\s+proto\s+(tcp|udp)\s*(?:comment\s+(.*))?$/i);
      if (plain) {
        addedRules.push({
          port: Number(plain[2]),
          endPort: plain[3] ? Number(plain[3]) : null,
          protocol: plain[4].toLowerCase(),
          action: plain[1].toUpperCase(),
          from: '',
          sourceSpec: '',
          comment: unquote(plain[5]),
        });
      } else if (bound) {
        addedRules.push({
          port: Number(bound[3]),
          endPort: bound[4] ? Number(bound[4]) : null,
          protocol: bound[5].toLowerCase(),
          action: bound[1].toUpperCase(),
          from: unquote(bound[2]),
          sourceSpec: unquote(bound[2]),
          comment: unquote(bound[6]),
        });
      }
    }
    // While ufw is switched off `ufw status` lists nothing, so the added rules are all we have.
    return { tool, active: /^Status:\s*active/im.test(text), readable: true, rules: rules.length ? rules : addedRules };
  }
  for (const line of body) {
    for (const token of line.trim().split(/\s+/)) {
      const m = token.match(/^(\d{1,5})(?:-(\d{1,5}))?\/(tcp|udp)$/);
      if (m) rules.push({ port: Number(m[1]), endPort: m[2] ? Number(m[2]) : null, protocol: m[3], action: 'ALLOW', from: '', sourceSpec: '', comment: '' });
    }
  }
  // Firewalld keeps source-bound rules out of --list-ports, so they arrive as rich rules instead.
  for (const line of rich || []) {
    const src = line.match(/source\s+address="([^"]+)"/);
    const port = line.match(/port\s+port="(\d{1,5})(?:-(\d{1,5}))?"/);
    const proto = line.match(/protocol="(tcp|udp)"/);
    if (!src || !port || !proto) continue;
    rules.push({
      port: Number(port[1]),
      endPort: port[2] ? Number(port[2]) : null,
      protocol: proto[1],
      action: /\breject\b|\bdrop\b/.test(line) ? 'DENY' : 'ALLOW',
      from: src[1],
      sourceSpec: src[1],
      comment: '',
    });
  }
  return { tool, active: /^state=running/m.test(text), readable: true, rules };
}

// `ufw status` prints the source and an optional `# comment` in one trailing field.
function splitFrom(tail) {
  const m = String(tail || '').match(/^(.*?)(?:\s*#\s*(.*))?$/);
  const from = (m[1] || '').trim();
  // "Anywhere" is ufw's way of writing "no source", so the UI only has one empty case to handle.
  const source = /^Anywhere(\s|$)/i.test(from) ? '' : from;
  return { from: source, sourceSpec: source, comment: (m[2] || '').trim() };
}

function unquote(value) {
  return String(value == null ? '' : value).trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

function splitAddress(s) {
  const i = s.lastIndexOf(':');
  return { address: s.slice(0, i).replace(/^\[|\]$/g, '').replace(/%\w+$/, ''), port: Number(s.slice(i + 1)) || 0 };
}

// ---------- What this login can do ----------

// Cheap enough to run alongside any tab: the UI uses it to stop offering actions that would fail.
const CAPS_SCRIPT = `${ENV_PRELUDE}
echo @@caps@@
echo "user=$(id -un)"
echo "uid=$(id -u)"
if [ "$(id -u)" = 0 ]; then echo "sudo=root"
elif has sudo && sudo -n true 2>/dev/null; then echo "sudo=nopasswd"
elif has sudo; then echo "sudo=password"
else echo "sudo=none"; fi
if docker ps -q >/dev/null 2>&1; then echo "docker=yes"; else echo "docker=no"; fi
echo "groups=$(id -Gn 2>/dev/null)"
`;

async function capabilities(serverId) {
  const res = await runScript(serverId, CAPS_SCRIPT, 30000);
  const info = {};
  for (const line of sections(res.stdout).caps || []) {
    const i = line.indexOf('=');
    if (i > 0) info[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const sudo = info.sudo || 'none';
  return {
    user: info.user || '',
    isRoot: info.uid === '0',
    sudo,
    // password still counts as able: the UI asks for it when a job needs it.
    canAct: sudo !== 'none',
    canDocker: info.docker === 'yes' || sudo !== 'none',
    groups: (info.groups || '').split(/\s+/).filter(Boolean),
  };
}

// ---------- Users and groups ----------

// Shadow and authorized_keys are only readable as root, so each part degrades on its own.
const USERS_SCRIPT = `${ENV_PRELUDE}
echo @@me@@
id -un
echo @@passwd@@
getent passwd 2>/dev/null
echo @@group@@
getent group 2>/dev/null
echo @@shadow@@
if [ "$(id -u)" = 0 ] && [ -r /etc/shadow ]; then awk -F: '{ print $1 ":" substr($2,1,1) }' /etc/shadow 2>/dev/null; fi
echo @@keys@@
getent passwd 2>/dev/null | awk -F: '($3 == 0 || ($3 >= 1000 && $3 < 65534)) { print $1 ":" $6 }' | while IFS=: read -r u home; do
  n=0; d=0
  [ -r "$home/.ssh/authorized_keys" ] && n=$(grep -c '^[a-z]' "$home/.ssh/authorized_keys" 2>/dev/null || echo 0)
  [ -r "$home/.ssh/authorized_keys.disabled" ] && d=$(grep -c '^[a-z]' "$home/.ssh/authorized_keys.disabled" 2>/dev/null || echo 0)
  echo "$u:$n:$d"
done
echo @@sudoers@@
if [ "$(id -u)" = 0 ]; then
  for f in /etc/sudoers.d/50-se-*; do [ -f "$f" ] && { echo "@@rule@@ $f"; cat "$f"; }; done
fi
echo @@sshd@@
sshd -T 2>/dev/null | grep -iE '^(passwordauthentication|permitrootlogin)' || true
echo @@uid@@
id -u
echo @@sessions@@
if has loginctl; then loginctl list-sessions --no-legend 2>/dev/null; fi
echo @@who@@
who 2>/dev/null
echo @@end@@
`;

const SUDO_GROUPS = new Set(['sudo', 'wheel', 'admin']);
const NOLOGIN = /(nologin|\/false)$/;

async function users(serverId) {
  const res = await runScript(serverId, USERS_SCRIPT);
  const s = sections(res.stdout);

  const groups = [];
  const memberOf = new Map();
  const primaryGid = new Map();
  for (const line of s.group || []) {
    const [name, , gid, members] = line.split(':');
    if (!name) continue;
    const list = (members || '').split(',').filter(Boolean);
    groups.push({ name, gid: Number(gid), members: list, system: Number(gid) < 1000 || Number(gid) >= 65534 });
    for (const m of list) {
      if (!memberOf.has(m)) memberOf.set(m, []);
      memberOf.get(m).push(name);
    }
  }

  const lockState = new Map();
  for (const line of s.shadow || []) {
    const [name, first] = line.split(':');
    if (name) lockState.set(name, first === '!' || first === '*');
  }
  const keyCounts = new Map();
  for (const line of s.keys || []) {
    const [name, n, d] = line.split(':');
    if (name) keyCounts.set(name, { keys: Number(n) || 0, disabledKeys: Number(d) || 0 });
  }

  const list = [];
  for (const line of s.passwd || []) {
    const [name, , uid, gid, gecos, home, shell] = line.split(':');
    if (!name) continue;
    const id = Number(uid);
    // Real people: root plus the normal login range. Service accounts are left out.
    if (!(id === 0 || (id >= 1000 && id < 65534))) continue;
    const primary = groups.find((g) => g.gid === Number(gid));
    if (primary) primaryGid.set(name, primary.name);
    const all = [...new Set([primary ? primary.name : null, ...(memberOf.get(name) || [])].filter(Boolean))];
    const counts = keyCounts.get(name) || { keys: 0, disabledKeys: 0 };
    list.push({
      name,
      uid: id,
      home: home || '',
      shell: shell || '',
      fullName: (gecos || '').split(',')[0] || '',
      groups: all,
      sudo: id === 0 || all.some((g) => SUDO_GROUPS.has(g)),
      docker: all.includes('docker'),
      locked: lockState.get(name) === true,
      noLogin: NOLOGIN.test(shell || ''),
      keys: counts.keys,
      disabledKeys: counts.disabledKeys,
      isRoot: id === 0,
    });
  }
  list.sort((a, b) => a.uid - b.uid || a.name.localeCompare(b.name));

  // What each group has been granted through its managed sudoers file.
  const permissions = new Map();
  let ruleGroup = null;
  for (const line of s.sudoers || []) {
    const start = line.match(/^@@rule@@ \/etc\/sudoers\.d\/50-se-(.+)$/);
    if (start) {
      ruleGroup = start[1];
      permissions.set(ruleGroup, { admin: false, services: [], docker: false });
      continue;
    }
    if (!ruleGroup) continue;
    const entry = permissions.get(ruleGroup);
    // The docker choice is stored as a comment, so it has to be read before comments are skipped.
    if (/^#\s*se:docker=yes\s*$/.test(line)) entry.docker = true;
    if (line.startsWith('#')) continue;
    if (/^%\S+\s+ALL=\(ALL\)\s+ALL\s*$/.test(line)) entry.admin = true;
    for (const m of line.matchAll(/systemctl\s+(?:start|stop|restart|status)\s+(\S+?)(?:,|$)/g)) {
      if (!entry.services.includes(m[1])) entry.services.push(m[1]);
    }
  }
  for (const group of groups) {
    const found = permissions.get(group.name);
    group.admin = found ? found.admin : false;
    group.services = found ? found.services : [];
    group.docker = found ? found.docker : group.name === 'docker';
  }

  const sshd = {};
  for (const line of s.sshd || []) {
    const [key, value] = line.trim().split(/\s+/);
    if (key) sshd[key.toLowerCase()] = value;
  }

  // Who is signed in right now. loginctl gives a session id that can be ended cleanly; who gives the
  // login time and where they came from. They are joined on the tty, and either source can be missing:
  // servers without systemd have no loginctl, and a session with no tty never reaches who.
  const sessions = [];
  const byTty = new Map();
  for (const line of s.sessions || []) {
    const [id, , user, , tty] = line.trim().split(/\s+/);
    if (!id || !user) continue;
    const entry = { id, user, tty: tty && tty !== '-' ? tty : '', host: '', since: '' };
    sessions.push(entry);
    if (entry.tty) byTty.set(entry.tty, entry);
  }
  for (const line of s.who || []) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(.+?)(?:\s+\(([^)]*)\))?\s*$/);
    if (!m) continue;
    const [, user, tty, since, host] = m;
    const found = byTty.get(tty);
    if (found) {
      found.since = since.trim();
      found.host = host || '';
    } else {
      sessions.push({ id: '', user, tty, host: host || '', since: since.trim() });
    }
  }
  sessions.sort((a, b) => a.user.localeCompare(b.user) || a.tty.localeCompare(b.tty));

  return {
    me: (s.me || [])[0] || '',
    users: list,
    sessions,
    // Signing someone else out is only offered to a real root connection, never to a sudo user.
    isRoot: (s.uid || [])[0] === '0',
    // Only the groups this app can honestly describe: the ones made here. System groups are left
    // out because their real rights live in /etc/sudoers and package files that are never read, so
    // the "Can do" column would understate them. The per-user group useradd creates beside each
    // account is left out too: it is an implementation detail, not a way to group people.
    groups: groups
      .filter((g) => !g.system && primaryGid.get(g.name) !== g.name)
      .sort((a, b) => a.name.localeCompare(b.name)),
    // Debian and Ubuntu use sudo, RHEL and friends use wheel, so the UI targets whichever exists.
    sudoGroup: ['sudo', 'wheel', 'admin'].find((n) => groups.some((g) => g.name === n)) || '',
    hasDockerGroup: groups.some((g) => g.name === 'docker'),
    passwordAuth: sshd.passwordauthentication === 'yes',
    permitRootLogin: sshd.permitrootlogin || '',
    // Without root the lock column and key counts are unknown rather than zero.
    limited: !(s.shadow || []).length,
  };
}

// ---------- Processes ----------

const PROCESSES_SCRIPT = `
ps -eo pid=,user=,pcpu=,pmem=,rss=,etime=,comm=,args= --sort=-pcpu 2>/dev/null | head -n 300 || ps -o pid,user,comm,args
`;

async function processes(serverId) {
  const res = await runScript(serverId, PROCESSES_SCRIPT);
  const list = [];
  for (const line of res.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    list.push({
      pid: Number(m[1]),
      user: m[2],
      cpu: Number(m[3]),
      mem: Number(m[4]),
      rss: Number(m[5]) * 1024,
      elapsed: m[6],
      name: m[7],
      command: m[8],
    });
  }
  return { list };
}

module.exports = { overview, apps, services, docker, ports, processes, users, capabilities };
