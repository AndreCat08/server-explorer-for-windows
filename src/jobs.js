// Jobs: shell scripts that change the server (install software, control services and containers,
// save protected files, create websites, set up HTTPS). Output is streamed live, and the script
// runs through sudo when the login user isn't root.
const ssh = require('./ssh');
const { CATALOG_BY_ID } = require('./install');

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9.+_:-]{0,100}$/;
const SERVICE_NAME = /^[A-Za-z0-9@._:-]{1,120}$/;
const CONTAINER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const FOLDER = /^\/[A-Za-z0-9._/-]{1,200}$/;
const TEMP_FILE = /^\/tmp\/\.se-edit-[0-9a-f-]{36}$/;
const REMOTE_PATH = /^\/[^\0\n\r]{1,4000}$/;
const ACTIONS = ['start', 'stop', 'restart'];
const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const SSH_KEY = /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]{32,}={0,3}( [^\n\r]{0,200})?$/;
const PW_TEMP = /^\/tmp\/\.se-pw-[0-9a-f-]{36}$/;
const SHELLS = ['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/sbin/nologin'];
const TTY_NAME = /^[A-Za-z0-9][A-Za-z0-9/:._-]{0,31}$/;
const SESSION_ID = /^[A-Za-z0-9]{1,32}$/;
// Cutting someone off mid-work is root's call alone: a sudo user is refused even though their
// script would run as root. startJob is the only place that knows the uid before sudo wraps it.
const ROOT_ONLY_KINDS = new Set(['sessionLogout']);
// root is never touched from here, and neither is the account this session is logged in as.
const PROTECTED_USERS = new Set(['root']);
const GROUPNAME = /^[a-z_][a-z0-9_-]{0,31}$/;
// Group folder sharing is deliberately confined to /home: everything else on the box either belongs
// to the system or holds running app data, where a recursive chmod is not something to offer.
const HOME_PATH = /^\/home(\/[A-Za-z0-9._][A-Za-z0-9._-]{0,63})*$/;
// Deleting any of these would break sign-in, sudo or Docker, so deletion skips them entirely.
const PROTECTED_GROUPS = new Set(['root', 'sudo', 'wheel', 'admin', 'docker', 'adm', 'shadow', 'ssh', 'ssh-users', 'users', 'staff', 'nogroup', 'nobody']);
const PROTECTED_SERVICES = new Set(['ssh', 'sshd', 'openssh-server']);
// A single IPv4/IPv6 address or CIDR block. Both ufw and firewalld take this form as-is.
const IPV4_SOURCE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const IPV6_SOURCE = /^[0-9A-Fa-f:]{2,45}(?:\/(\d{1,3}))?$/;
// The ufw comment: free one-line text. Quotes and backslashes are kept out so the value survives
// both this script's quoting and ufw's own parsing of the rule it stores.
const RULE_COMMENT = /^[^\n\r'"\\`$]{0,120}$/;
// One firewall command is emitted per source, so this also caps how long a single job gets.
const MAX_SOURCES = 10;
const DOCKER_KINDS = new Set(['container', 'containerLogs', 'imageRemove', 'dockerInspect']);
// Jobs whose output is shown as-is, without the trailing "Done."
const RAW_OUTPUT_KINDS = new Set(['serviceLogs', 'containerLogs', 'aiCommand']);

// Shared helpers for every job script. Stdin is closed first so nothing (e.g. a sudo password
// left in the pipe) can be read by the commands that follow.
const PRELUDE = `
exec </dev/null
set -e
export DEBIAN_FRONTEND=noninteractive
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/snap/bin"
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v apk >/dev/null 2>&1; then PM=apk
elif command -v pacman >/dev/null 2>&1; then PM=pacman
else PM=none; fi
APT_UPDATED=
pkg_install() {
  case $PM in
    apt) [ -n "$APT_UPDATED" ] || { apt-get update -q; APT_UPDATED=1; }
         apt-get install -y -q -o Dpkg::Lock::Timeout=300 "$@" ;;
    dnf|yum) $PM install -y "$@" ;;
    apk) apk add "$@" ;;
    pacman) pacman -Sy --noconfirm --needed "$@" ;;
    *) echo "No supported package manager (apt, dnf, yum, apk, pacman) was found."; exit 1 ;;
  esac
}
is_installed() {
  case $PM in
    apt) dpkg -s "$1" 2>/dev/null | grep -q '^Status: install ok installed' ;;
    dnf|yum) rpm -q "$1" >/dev/null 2>&1 ;;
    apk) apk info -e "$1" >/dev/null 2>&1 ;;
    pacman) pacman -Q "$1" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
pkg_remove() {
  set -- $(for p in "$@"; do if is_installed "$p"; then echo "$p"; fi; done)
  if [ $# -eq 0 ]; then echo "Nothing to remove."; return 0; fi
  case $PM in
    apt) apt-get remove -y -q -o Dpkg::Lock::Timeout=300 "$@" ;;
    dnf|yum) $PM remove -y "$@" ;;
    apk) apk del "$@" ;;
    pacman) pacman -R --noconfirm "$@" ;;
  esac
}
has_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }
start_service() {
  if has_systemd; then
    systemctl enable --now "$1" || echo "Note: could not start $1 automatically."
  elif command -v service >/dev/null 2>&1; then
    service "$1" start || echo "Note: could not start $1 automatically."
  fi
}
reload_nginx() {
  if has_systemd; then systemctl reload nginx
  elif command -v service >/dev/null 2>&1 && service nginx status >/dev/null 2>&1; then service nginx reload
  else nginx -s reload; fi
}
need_curl() { command -v curl >/dev/null 2>&1 || pkg_install curl ca-certificates; }
unsupported() { echo "Installing this app isn't supported on this system ($PM) yet."; exit 1; }
`;

function byPackageManager(recipes) {
  const branches = Object.entries(recipes)
    .filter(([pm]) => pm !== '*')
    .map(([pm, body]) => `  ${pm === 'dnf' ? 'dnf|yum' : pm})\n${body}\n  ;;`);
  branches.push(`  *)\n${recipes['*'] || 'unsupported'}\n  ;;`);
  return `case $PM in\n${branches.join('\n')}\nesac`;
}

function siteConfig({ names, type, port, folder }) {
  const lines = ['server {', '    listen 80;', '    listen [::]:80;', `    server_name ${names.join(' ')};`, ''];
  if (type === 'proxy') {
    lines.push(
      '    location / {',
      `        proxy_pass http://127.0.0.1:${port};`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      '        proxy_set_header Upgrade $http_upgrade;',
      '        proxy_set_header Connection "upgrade";',
      '    }'
    );
  } else {
    lines.push(`    root ${folder};`, '    index index.html index.htm index.php;', '', '    location / {', '        try_files $uri $uri/ =404;', '    }');
  }
  lines.push('}');
  return `# Created by Server Explorer\n${lines.join('\n')}\n`;
}

// Every user job goes through this: it is the only thing standing between the app and a lockout.
function checkUser(spec) {
  const name = String(spec.name || '');
  if (!USERNAME.test(name)) throw new Error('Enter a username made of lowercase letters, digits, - and _');
  if (PROTECTED_USERS.has(name)) throw new Error('The root account cannot be changed from here.');
  if (name === String(spec.me || '')) throw new Error('This is the account you are logged in with, so it cannot be changed from here.');
  return name;
}

// Resolves the user's home directory inside the script, since it is not always /home/<name>.
const HOME_OF = (name) => `H=$(getent passwd ${name} | cut -d: -f6); [ -n "$H" ] || { echo "Could not find that user's home folder."; exit 1; }`;

function checkGroup(value) {
  const name = String(value || '');
  if (!GROUPNAME.test(name)) throw new Error('Enter a group name made of lowercase letters, digits, - and _');
  if (name === 'root') throw new Error('The root group cannot be changed from here.');
  return name;
}

// Splits the comma-separated source box into validated addresses. An empty result means
// "from anywhere", which is the rule form the firewall tools use when no source is given.
function parseSources(value) {
  const text = Array.isArray(value) ? value.join(',') : value;
  const raw = String(text == null ? '' : text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const entry of raw) {
    if (!checkSource(entry)) throw new Error(`"${entry}" is not an IP address or range. Use a form like 203.0.113.4 or 10.0.0.0/24.`);
    if (!out.includes(entry)) out.push(entry);
  }
  if (out.length > MAX_SOURCES) throw new Error(`List at most ${MAX_SOURCES} addresses.`);
  return out;
}

// The regexes alone would pass 999.1.1.1 and a /64 on IPv4, so the numbers are range-checked here.
function checkSource(entry) {
  const v4 = entry.match(IPV4_SOURCE);
  if (v4) {
    if (v4.slice(1, 5).some((n) => Number(n) > 255)) return false;
    return v4[5] === undefined || Number(v4[5]) <= 32;
  }
  const v6 = entry.includes(':') ? entry.match(IPV6_SOURCE) : null;
  if (v6) return v6[1] === undefined || Number(v6[1]) <= 128;
  return false;
}

function checkComment(value) {
  const text = String(value == null ? '' : value).trim();
  if (!RULE_COMMENT.test(text)) throw new Error('The description must be one line, at most 120 characters, without quotes or backslashes.');
  return text;
}

function checkAction(action) {
  if (!ACTIONS.includes(action)) throw new Error('Unknown action');
}

function scriptBody(spec) {
  switch (spec.kind) {
    case 'catalog': {
      const item = CATALOG_BY_ID.get(spec.id);
      if (!item) throw new Error('Unknown app');
      if (spec.action === 'remove') {
        if (!item.remove) throw new Error(`${item.name} can't be uninstalled from here.`);
        return byPackageManager(item.remove);
      }
      return byPackageManager(item.install) + (item.after ? `\n${item.after}` : '');
    }

    case 'package':
      if (!PACKAGE_NAME.test(spec.name || '')) throw new Error('Invalid package name');
      return `pkg_install ${q(spec.name)}`;

    case 'refresh':
      return 'case $PM in apt) apt-get update ;; dnf|yum) $PM makecache ;; apk) apk update ;; pacman) pacman -Sy ;; esac';

    case 'service': {
      if (!SERVICE_NAME.test(spec.name || '')) throw new Error('Invalid service name');
      checkAction(spec.action);
      if (spec.action === 'stop' && PROTECTED_SERVICES.has(spec.name.replace(/\.service$/, ''))) {
        throw new Error('Stopping SSH would disconnect you from the server, so it is blocked here.');
      }
      const name = q(spec.name);
      return `if has_systemd; then systemctl ${spec.action} ${name}; echo "Status: $(systemctl is-active ${name} || true)"; else service ${name} ${spec.action}; fi`;
    }

    case 'serviceLogs':
      if (!SERVICE_NAME.test(spec.name || '')) throw new Error('Invalid service name');
      return `if command -v journalctl >/dev/null 2>&1; then journalctl -u ${q(spec.name)} -n 300 --no-pager; else echo "Service logs are only available on servers that use systemd."; fi`;

    case 'container':
      if (!CONTAINER_ID.test(spec.id || '')) throw new Error('Invalid container');
      checkAction(spec.action);
      return `docker ${spec.action} ${q(spec.id)}`;

    case 'containerLogs':
      if (!CONTAINER_ID.test(spec.id || '')) throw new Error('Invalid container');
      return `docker logs --tail 300 ${q(spec.id)} 2>&1`;

    // No -f on purpose: forcing would delete an image a stopped container still needs, breaking it
    // silently. Without it docker refuses and says which container is in the way.
    case 'imageRemove':
      if (!CONTAINER_ID.test(spec.id || '')) throw new Error('Invalid image');
      return `docker rmi ${q(spec.id)}`;

    // Read-only. The full JSON is returned and the caller picks out what it needs: docker's template
    // engine has no reliable way to select a subset, and a half-matched template silently prints
    // nothing rather than failing.
    case 'dockerInspect': {
      if (!CONTAINER_ID.test(spec.id || '')) throw new Error('Invalid item');
      if (spec.target === 'image') return `docker image inspect ${q(spec.id)}`;
      if (spec.target === 'compose') {
        // A project is its containers: inspect whichever ones still carry its compose label.
        return [
          `IDS=$(docker ps -aq --filter label=com.docker.compose.project=${q(spec.id)})`,
          `[ -n "$IDS" ] || { echo "No containers found for the compose project ${spec.id}."; exit 1; }`,
          'docker inspect $IDS',
        ].join('\n');
      }
      return `docker inspect ${q(spec.id)}`;
    }

    case 'writeFile':
      // The editor uploads the new content to a private temp file; this copies it into place
      // (keeping the target's owner and permissions) and always removes the temp file.
      if (!TEMP_FILE.test(spec.tmp || '') || !REMOTE_PATH.test(spec.target || '')) throw new Error('Invalid file path');
      return `trap "rm -f ${q(spec.tmp)}" EXIT\ncat ${q(spec.tmp)} > ${q(spec.target)}`;

    case 'nginxReload':
      return 'nginx -t\nreload_nginx\necho "Nginx reloaded with the new configuration."';

    case 'createSite': {
      const domain = String(spec.domain || '').toLowerCase();
      if (!DOMAIN.test(domain)) throw new Error('Enter a valid domain name, like example.com');
      const names = [domain];
      if (spec.www && !domain.startsWith('www.')) names.push(`www.${domain}`);
      let port;
      let folder;
      if (spec.type === 'proxy') {
        port = Number(spec.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port between 1 and 65535');
      } else if (spec.type === 'folder') {
        folder = String(spec.folder || '');
        if (!FOLDER.test(folder) || folder.includes('..')) throw new Error('Enter a folder path like /var/www/example.com');
      } else {
        throw new Error('Choose what the website should show');
      }
      const lines = [
        'command -v nginx >/dev/null 2>&1 || { echo "Nginx is not installed. Install it from Installed Apps first."; exit 1; }',
        `if [ -d /etc/nginx/sites-available ]; then CONF=/etc/nginx/sites-available/${domain}; LINK=/etc/nginx/sites-enabled/${domain}; else CONF=/etc/nginx/conf.d/${domain}.conf; LINK=; fi`,
        'if [ -e "$CONF" ]; then echo "A website config already exists at $CONF. Edit it from the Websites tab instead."; exit 1; fi',
        `cat > "$CONF" <<'SERVER_EXPLORER_EOF'\n${siteConfig({ names, type: spec.type, port, folder })}SERVER_EXPLORER_EOF`,
        'echo "Created $CONF"',
        'if [ -n "$LINK" ]; then mkdir -p /etc/nginx/sites-enabled; ln -s "$CONF" "$LINK"; fi',
      ];
      if (folder) {
        const f = q(folder);
        lines.push(
          `if [ ! -d ${f} ]; then`,
          `  mkdir -p ${f}`,
          `  printf '%s\\n' '<!doctype html><meta charset="utf-8"><title>${domain}</title><h1>${domain} is working</h1>' > ${f}/index.html`,
          `  if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != root ]; then chown -R "$SUDO_USER" ${f}; fi`,
          `  echo "Created the folder ${folder} with a placeholder page"`,
          'fi'
        );
      }
      lines.push(
        'echo "Testing the Nginx configuration..."',
        'if ! nginx -t; then rm -f "$CONF"; if [ -n "$LINK" ]; then rm -f "$LINK"; fi; echo "The configuration test failed, so the new website was removed again."; exit 1; fi',
        'reload_nginx',
        'if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 80/tcp; ufw allow 443/tcp; fi',
        `echo "Website ${domain} is live at http://${domain}"`
      );
      return lines.join('\n');
    }

    case 'certbot': {
      const domains = (spec.domains || []).map((d) => String(d).toLowerCase());
      if (!domains.length || !domains.every((d) => DOMAIN.test(d))) throw new Error('Invalid domain name');
      const email = String(spec.email || '').trim();
      if (!EMAIL.test(email)) throw new Error('Enter a valid email address');
      return [
        'command -v nginx >/dev/null 2>&1 || { echo "Nginx is not installed."; exit 1; }',
        'if ! command -v certbot >/dev/null 2>&1; then echo "Installing Certbot..."; case $PM in apk|pacman) pkg_install certbot certbot-nginx ;; *) pkg_install certbot python3-certbot-nginx ;; esac; fi',
        'if ! certbot plugins 2>/dev/null | grep -q nginx; then echo "Installing the Certbot Nginx plugin..."; case $PM in apk|pacman) pkg_install certbot-nginx ;; *) pkg_install python3-certbot-nginx ;; esac; fi',
        `certbot --nginx --non-interactive --agree-tos --redirect -m ${q(email)} ${domains.map((d) => `-d ${q(d)}`).join(' ')}`,
      ].join('\n');
    }

    case 'firewallPort': {
      const port = Number(spec.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port between 1 and 65535');
      const protocol = spec.protocol === 'udp' ? 'udp' : 'tcp';
      if (spec.action !== 'open' && spec.action !== 'close') throw new Error('Unknown action');
      const sshPort = Number(spec.sshPort);
      if (spec.action === 'close' && (port === 22 || port === sshPort)) {
        throw new Error('Closing the SSH port would disconnect you from the server, so it is blocked here.');
      }
      const sources = parseSources(spec.sources);
      const comment = checkComment(spec.comment);
      // The port and protocol come from a validated number and a fixed word, but the source and the
      // comment are the user's own text, so every one of those goes through q().
      const rule = `${port}/${protocol}`;
      const opening = spec.action === 'open';
      // Firewalld has no comment field, so the description is kept locally by the app instead.
      const richRule = (src) =>
        q(`rule family="${src.includes(':') ? 'ipv6' : 'ipv4'}" source address="${src}" port port="${port}" protocol="${protocol}" accept`);
      const ufwLines = [];
      const firewalldLines = [];
      if (!sources.length) {
        // ufw matches an existing rule by its port and source alone, so a delete carries no comment.
        const tail = opening && comment ? ` comment ${q(comment)}` : '';
        ufwLines.push(`  ufw ${opening ? 'allow' : 'delete allow'} ${rule}${tail}`);
        firewalldLines.push(`  firewall-cmd --permanent --${opening ? 'add' : 'remove'}-port=${rule}`);
      } else {
        for (const src of sources) {
          const tail = opening && comment ? ` comment ${q(comment)}` : '';
          ufwLines.push(`  ufw ${opening ? 'allow' : 'delete allow'} from ${q(src)} to any port ${port} proto ${protocol}${tail}`);
          firewalldLines.push(`  firewall-cmd --permanent --${opening ? 'add' : 'remove'}-rich-rule=${richRule(src)}`);
        }
      }
      const where = sources.length ? ` from ${sources.join(', ')}` : '';
      if (opening) {
        return [
          'if command -v ufw >/dev/null 2>&1; then',
          ...ufwLines,
          '  ufw status | grep -q "Status: active" || echo "Note: the UFW firewall is switched off, so this rule is saved but not enforced yet."',
          'elif command -v firewall-cmd >/dev/null 2>&1; then',
          ...firewalldLines,
          '  firewall-cmd --reload',
          'else',
          '  echo "No supported firewall (ufw or firewalld) is installed, so this port is already open unless your hosting provider blocks it."; exit 1',
          'fi',
          `echo "Port ${rule} is open${where}."`,
        ].join('\n');
      }
      return [
        'if command -v ufw >/dev/null 2>&1; then',
        ...ufwLines,
        'elif command -v firewall-cmd >/dev/null 2>&1; then',
        ...firewalldLines,
        '  firewall-cmd --reload',
        'else',
        '  echo "No supported firewall (ufw or firewalld) is installed, so there is no rule to remove."; exit 1',
        'fi',
        `echo "Port ${rule} is closed${where}."`,
      ].join('\n');
    }

    // Changing a rule means replacing it: no firewall can edit one in place. Only the source and the
    // description move, so the port and protocol are taken as given and never rewritten here.
    case 'firewallPortEdit': {
      const port = Number(spec.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port between 1 and 65535');
      const protocol = spec.protocol === 'udp' ? 'udp' : 'tcp';
      const sources = parseSources(spec.sources);
      const oldSources = parseSources(spec.oldSources);
      const comment = checkComment(spec.comment);
      const sshPort = Number(spec.sshPort);
      // Narrowing the SSH rule to a list of addresses locks the user out if any of them is wrong,
      // and the lockout only shows up after the old rule is gone.
      if ((port === 22 || port === sshPort) && !oldSources.length && sources.length) {
        throw new Error(
          'Limiting the SSH port to specific addresses could lock you out of the server, so it is blocked here. Change it from your hosting provider’s console instead.'
        );
      }
      const rule = `${port}/${protocol}`;
      const richRule = (src) =>
        q(`rule family="${src.includes(':') ? 'ipv6' : 'ipv4'}" source address="${src}" port port="${port}" protocol="${protocol}" accept`);
      const allowUfw = (src) =>
        `  ufw allow ${src ? `from ${q(src)} to any port ${port} proto ${protocol}` : rule}${comment ? ` comment ${q(comment)}` : ''}`;
      const deleteUfw = (src) => `  ufw delete allow ${src ? `from ${q(src)} to any port ${port} proto ${protocol}` : rule}`;
      const addFirewalld = (src) => `  firewall-cmd --permanent --add-${src ? `rich-rule=${richRule(src)}` : `port=${rule}`}`;
      const removeFirewalld = (src) => `  firewall-cmd --permanent --remove-${src ? `rich-rule=${richRule(src)}` : `port=${rule}`}`;
      const sameSources = sources.length === oldSources.length && sources.every((s, i) => s === oldSources[i]);

      const ufwLines = [];
      const firewalldLines = [];
      if (sameSources) {
        // ufw identifies a rule by its port, protocol and source, ignoring the comment. Re-adding the
        // same rule therefore just overwrites the comment; deleting afterwards would remove the rule
        // that was only meant to be relabelled.
        for (const src of sources.length ? sources : ['']) ufwLines.push(allowUfw(src));
        firewalldLines.push('  : # only the description changed, and firewalld keeps that in the app');
      } else {
        // The new rule goes in before the old one comes out: `set -e` stops the script on a failed
        // add, which leaves the old rule in place rather than the port with no rule at all.
        for (const src of sources.length ? sources : ['']) {
          ufwLines.push(allowUfw(src));
          firewalldLines.push(addFirewalld(src));
        }
        for (const src of oldSources.length ? oldSources : ['']) {
          ufwLines.push(deleteUfw(src));
          firewalldLines.push(removeFirewalld(src));
        }
      }
      const where = sources.length ? ` from ${sources.join(', ')}` : ' from anywhere';
      return [
        'if command -v ufw >/dev/null 2>&1; then',
        ...ufwLines,
        '  ufw status | grep -q "Status: active" || echo "Note: the UFW firewall is switched off, so this rule is saved but not enforced yet."',
        'elif command -v firewall-cmd >/dev/null 2>&1; then',
        ...firewalldLines,
        '  firewall-cmd --reload',
        'else',
        '  echo "No supported firewall (ufw or firewalld) is installed, so there is no rule to change."; exit 1',
        'fi',
        `echo "Port ${rule} is now open${where}."`,
      ].join('\n');
    }

    case 'firewallEnable': {
      const sshPort = Number(spec.sshPort);
      if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('Unknown SSH port');
      return [
        'command -v ufw >/dev/null 2>&1 || { echo "UFW is not installed, so there is nothing to switch on."; exit 1; }',
        // SSH is allowed first on purpose: enabling ufw blocks everything else, which would cut this connection.
        `ufw allow ${sshPort}/tcp`,
        `echo "Allowed SSH on port ${sshPort}/tcp first, so this connection keeps working."`,
        'ufw --force enable',
        'ufw status',
      ].join('\n');
    }

    case 'firewallDisable':
      // Rules stay stored while ufw is off, so switching it back on restores them.
      return [
        'command -v ufw >/dev/null 2>&1 || { echo "UFW is not installed, so there is nothing to switch off."; exit 1; }',
        'ufw disable',
        'echo "The firewall is off. Your rules are kept and apply again when you switch it back on."',
      ].join('\n');

    case 'userCreate': {
      const name = checkUser(spec);
      const shell = SHELLS.includes(spec.shell) ? spec.shell : '/bin/bash';
      const groups = [...new Set((spec.groups || []).map(String))];
      for (const g of groups) {
        if (!GROUPNAME.test(g)) throw new Error(`Invalid group name: ${g}`);
        if (PROTECTED_GROUPS.has(g)) throw new Error(`Joining ${g} at creation is not offered here.`);
      }
      return [
        'command -v useradd >/dev/null 2>&1 || { echo "This server has no useradd command."; exit 1; }',
        `if id -u ${q(name)} >/dev/null 2>&1; then echo "The user ${name} already exists."; exit 1; fi`,
        // Checked before useradd rather than through its -G flag: set -e would otherwise abort on a
        // missing group and leave no account at all.
        ...groups.map((g) => `getent group ${q(g)} >/dev/null 2>&1 || { echo "There is no group called ${g}."; exit 1; }`),
        `useradd -m -s ${q(shell)} ${q(name)}`,
        HOME_OF(q(name)),
        `install -d -m 700 -o ${q(name)} -g ${q(name)} "$H/.ssh"`,
        ...groups.map((g) => `gpasswd -a ${q(name)} ${q(g)}`),
        // Docker access is a setting on the group, so someone created into one must follow it.
        // Without this they carry the group's Docker badge but not the access.
        ...groups.map(
          (g) => `if grep -q '^# se:docker=yes' ${q(`/etc/sudoers.d/50-se-${g}`)} 2>/dev/null && getent group docker >/dev/null 2>&1; then gpasswd -a ${q(name)} docker || true; fi`
        ),
        groups.length ? `echo "Created the user ${name} and added them to ${groups.join(', ')}."` : `echo "Created the user ${name}."`,
      ].join('\n');
    }

    case 'userDelete': {
      const name = checkUser(spec);
      const removeHome = spec.removeHome ? '-r ' : '';
      return [
        `UID_N=$(id -u ${q(name)} 2>/dev/null)`,
        `[ -n "$UID_N" ] || { echo "There is no user called ${name}."; exit 1; }`,
        `if [ "$UID_N" -ne 0 ] && { [ "$UID_N" -lt 1000 ] || [ "$UID_N" -ge 65534 ]; }; then echo "${name} is a system account (id $UID_N), so it is left alone."; exit 1; fi`,
        `pkill -u ${q(name)} 2>/dev/null || true`,
        `userdel ${removeHome}${q(name)}`,
        `echo "Deleted the user ${name}."`,
      ].join('\n');
    }

    // Targets one session by id or tty, never by username: when connected as root, ending another
    // root session is legitimate, so checkUser's root/self rules do not apply here.
    case 'sessionLogout': {
      const tty = String(spec.tty || '');
      const id = String(spec.id || '');
      if (!tty && !id) throw new Error('No session was given.');
      if (tty && !TTY_NAME.test(tty)) throw new Error('Invalid session.');
      if (id && !SESSION_ID.test(id)) throw new Error('Invalid session.');
      const label = tty || `session ${id}`;
      return [
        id ? `if command -v loginctl >/dev/null 2>&1 && loginctl terminate-session ${q(id)} 2>/dev/null; then echo "Signed ${label} out."; exit 0; fi` : '',
        tty ? `pkill -HUP -t ${q(tty)} 2>/dev/null || true` : '',
        tty ? 'sleep 2' : '',
        tty ? `pkill -KILL -t ${q(tty)} 2>/dev/null || true` : '',
        `echo "Signed ${label} out."`,
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'userLock':
    case 'userUnlock': {
      const name = checkUser(spec);
      const lock = spec.kind === 'userLock';
      return [
        HOME_OF(q(name)),
        lock ? `usermod -L ${q(name)}` : `usermod -U ${q(name)}`,
        // Keys are moved aside rather than deleted, so unlocking puts them back.
        lock
          ? '[ -f "$H/.ssh/authorized_keys" ] && mv -f "$H/.ssh/authorized_keys" "$H/.ssh/authorized_keys.disabled" || true'
          : '[ -f "$H/.ssh/authorized_keys.disabled" ] && mv -f "$H/.ssh/authorized_keys.disabled" "$H/.ssh/authorized_keys" || true',
        lock ? `echo "${name} can no longer sign in. Their keys are kept and come back when you switch it on again."` : `echo "${name} can sign in again."`,
      ].join('\n');
    }

    case 'userAddKey':
    case 'userRemoveKey': {
      const name = checkUser(spec);
      const raw = String(spec.key || '').trim();
      // Several pasted lines would collapse into one key whose comment swallowed the rest, which
      // looks like success while only the first key is actually installed.
      if (/[\n\r]/.test(raw)) throw new Error('Paste one key on a single line. Add more keys one at a time.');
      const key = raw.replace(/\s+/g, ' ');
      if (!SSH_KEY.test(key)) throw new Error('That does not look like an SSH public key. It should start with ssh-ed25519 or ssh-rsa.');
      const add = spec.kind === 'userAddKey';
      return [
        HOME_OF(q(name)),
        `install -d -m 700 -o ${q(name)} -g ${q(name)} "$H/.ssh"`,
        'touch "$H/.ssh/authorized_keys"',
        add
          ? `grep -qxF ${q(key)} "$H/.ssh/authorized_keys" && echo "That key is already there." || printf '%s\\n' ${q(key)} >> "$H/.ssh/authorized_keys"`
          : `grep -vxF ${q(key)} "$H/.ssh/authorized_keys" > "$H/.ssh/.se-keys" && mv -f "$H/.ssh/.se-keys" "$H/.ssh/authorized_keys"`,
        `chown ${q(name)}:${q(name)} "$H/.ssh/authorized_keys"`,
        'chmod 600 "$H/.ssh/authorized_keys"',
        add ? `echo "The key was added for ${name}."` : `echo "The key was removed for ${name}."`,
      ].join('\n');
    }

    case 'userPassword': {
      const name = checkUser(spec);
      // The password arrives in a private temp file: it must never appear in the command line.
      if (!PW_TEMP.test(spec.tmp || '')) throw new Error('Invalid password file');
      return [
        `trap "rm -f ${q(spec.tmp)}" EXIT`,
        `chpasswd < ${q(spec.tmp)}`,
        `rm -f ${q(spec.tmp)}`,
        `echo "The password for ${name} was set."`,
      ].join('\n');
    }

    case 'sshPasswordUsers': {
      const names = (spec.users || []).map((u) => String(u));
      if (!names.every((u) => USERNAME.test(u) && !PROTECTED_USERS.has(u))) throw new Error('Invalid username in the list');
      const block = names.length
        ? `# Managed by Server Explorer. Password sign-in is limited to these users.\nMatch User ${names.join(',')}\n    PasswordAuthentication yes\n`
        : '# Managed by Server Explorer. No user may sign in with a password.\n';
      return [
        'CONF=/etc/ssh/sshd_config',
        'cp -a "$CONF" "$CONF.se-backup.$(date +%s)"',
        `if grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/\\*\\.conf' "$CONF"; then`,
        '  mkdir -p /etc/ssh/sshd_config.d',
        `  cat > /etc/ssh/sshd_config.d/50-server-explorer.conf <<'SE_EOF'\n${block}SE_EOF`,
        'else',
        // No Include support: keep the block at the very end, because Match applies to everything after it.
        "  sed -i '/# >>> Server Explorer/,/# <<< Server Explorer/d' \"$CONF\"",
        `  cat >> "$CONF" <<'SE_EOF'\n# >>> Server Explorer\n${block}# <<< Server Explorer\nSE_EOF`,
        'fi',
        'if ! sshd -t; then echo "The SSH configuration test failed, so nothing was changed."; exit 1; fi',
        'if has_systemd; then systemctl reload sshd 2>/dev/null || systemctl reload ssh; else service ssh reload || service sshd reload; fi',
        names.length
          ? `echo "Password sign-in is now allowed for: ${names.join(', ')}. Everyone else, including root, stays key-only."`
          : 'echo "Password sign-in is switched off for every user."',
      ].join('\n');
    }

    case 'groupCreate': {
      const name = checkGroup(spec.name);
      return [
        `if getent group ${q(name)} >/dev/null 2>&1; then echo "The group ${name} already exists."; exit 1; fi`,
        `groupadd ${q(name)}`,
        `echo "Created the group ${name}."`,
      ].join('\n');
    }

    case 'groupMembers': {
      const name = checkGroup(spec.name);
      const add = (spec.add || []).map(String);
      const remove = (spec.remove || []).map(String);
      for (const user of [...add, ...remove]) {
        if (!USERNAME.test(user)) throw new Error('Invalid username in the member list');
      }
      if (remove.includes('root')) throw new Error('Root cannot be removed from a group here.');
      if (spec.me && remove.includes(String(spec.me))) throw new Error('You cannot remove your own account from a group here.');
      const lines = [
        `getent group ${q(name)} >/dev/null 2>&1 || { echo "There is no group called ${name}."; exit 1; }`,
        ...add.map((user) => `gpasswd -a ${q(user)} ${q(name)}`),
        ...remove.map((user) => `gpasswd -d ${q(user)} ${q(name)}`),
      ];
      // Nothing to do also means the docker block below would be empty, which is a shell syntax
      // error, so this early return has to stay above it.
      if (!add.length && !remove.length) return 'echo "Nothing to change."';
      // Docker access is a setting on the group, so people joining or leaving must follow it.
      // Without this a member added later carries the group's Docker badge but not the access.
      lines.push(
        `if grep -q '^# se:docker=yes' ${q(`/etc/sudoers.d/50-se-${name}`)} 2>/dev/null && getent group docker >/dev/null 2>&1; then`,
        ...add.map((user) => `  gpasswd -a ${q(user)} docker || true`),
        ...remove.map((user) => `  gpasswd -d ${q(user)} docker || true`),
        'fi'
      );
      lines.push(`echo "Updated who is in ${name}."`);
      return lines.join('\n');
    }

    case 'groupDelete': {
      const name = checkGroup(spec.name);
      if (PROTECTED_GROUPS.has(name)) throw new Error(`The ${name} group is part of the system, so it cannot be deleted here.`);
      return [
        `GID=$(getent group ${q(name)} | cut -d: -f3)`,
        `[ -n "$GID" ] || { echo "There is no group called ${name}."; exit 1; }`,
        // System groups own things across the OS; only groups made for people are removable here.
        // Both ends of the id range are system territory: low ids, and 65534+ for nobody/nogroup.
        `if [ "$GID" -lt 1000 ] || [ "$GID" -ge 65534 ]; then echo "${name} is a system group (id $GID), so it is left alone."; exit 1; fi`,
        `if getent passwd | awk -F: -v g="$GID" '$4 == g { print $1 }' | grep -q .; then echo "Some users still have ${name} as their main group, so it was not deleted."; exit 1; fi`,
        `groupdel ${q(name)}`,
        `echo "Deleted the group ${name}. Files it owned keep the old id until you give them a new group."`,
      ].join('\n');
    }

    case 'groupPermissions': {
      const name = checkGroup(spec.name);
      const admin = spec.admin === true;
      const services = [...new Set((spec.services || []).map(String))];
      for (const unit of services) {
        if (!SERVICE_NAME.test(unit)) throw new Error(`Invalid service name: ${unit}`);
      }
      const docker = spec.docker === true;
      const members = [...new Set((spec.members || []).map(String))];
      for (const user of members) {
        if (!USERNAME.test(user)) throw new Error(`Invalid username: ${user}`);
      }
      // The docker choice is a group setting, so it is recorded here rather than inferred from who
      // happens to be in the docker group. That way an empty group remembers it too.
      const lines = [
        `# Managed by Server Explorer for the group ${name}. Edits here are overwritten.`,
        `# se:docker=${docker ? 'yes' : 'no'}`,
      ];
      if (admin) {
        lines.push(`%${name} ALL=(ALL) ALL`);
      }
      // Services are kept even alongside admin: they are what the user ticked, and admin may be
      // switched off again later without losing the list.
      if (services.length) {
        // Both paths are listed because systemctl lives in /bin on some systems and /usr/bin on others.
        const commands = [];
        for (const unit of services) {
          for (const bin of ['/bin/systemctl', '/usr/bin/systemctl']) {
            for (const verb of ['start', 'stop', 'restart', 'status']) commands.push(`${bin} ${verb} ${unit}`);
          }
        }
        lines.push(`%${name} ALL=(ALL) NOPASSWD: ${commands.join(', ')}`);
      }
      const file = `/etc/sudoers.d/50-se-${name}`;
      // Docker membership follows the setting for whoever is in the group right now.
      const dockerSync = members.length
        ? [
            'if getent group docker >/dev/null 2>&1; then',
            ...members.map((user) => `  gpasswd ${docker ? '-a' : '-d'} ${q(user)} docker || true`),
            'fi',
          ]
        : [];
      if (!admin && !services.length && !docker) {
        return [
          `rm -f ${q(file)}`,
          ...dockerSync,
          `echo "${name} has no extra rights now. Members can still use anything shared with the group."`,
        ].join('\n');
      }
      return [
        'command -v visudo >/dev/null 2>&1 || { echo "This server has no visudo, so sudo rules are not changed from here."; exit 1; }',
        'mkdir -p /etc/sudoers.d',
        'TMP=$(mktemp /tmp/se-sudoers.XXXXXX)',
        'trap "rm -f $TMP" EXIT',
        `cat > "$TMP" <<'SE_SUDO_EOF'\n${lines.join('\n')}\nSE_SUDO_EOF`,
        'chmod 0440 "$TMP"',
        // Never install a sudoers file that has not been checked: a bad one breaks sudo for everyone.
        'if ! visudo -cf "$TMP"; then echo "The sudo rule was rejected as invalid, so nothing was changed."; exit 1; fi',
        `install -m 0440 -o root -g root "$TMP" ${q(file)}`,
        ...dockerSync,
        `echo "Saved what ${name} may do: ${[admin ? 'admin' : null, docker ? 'Docker' : null, services.length ? `services (${services.join(', ')})` : null].filter(Boolean).join(', ') || 'nothing extra'}."`,
      ].join('\n');
    }

    case 'groupRename': {
      const from = checkGroup(spec.name);
      const to = checkGroup(spec.newName);
      if (PROTECTED_GROUPS.has(from)) throw new Error(`The ${from} group is part of the system, so it cannot be renamed.`);
      if (from === to) return 'echo "That is already the name."';
      const oldFile = `/etc/sudoers.d/50-se-${from}`;
      const newFile = `/etc/sudoers.d/50-se-${to}`;
      return [
        `getent group ${q(from)} >/dev/null 2>&1 || { echo "There is no group called ${from}."; exit 1; }`,
        `if getent group ${q(to)} >/dev/null 2>&1; then echo "A group called ${to} already exists."; exit 1; fi`,
        `groupmod -n ${q(to)} ${q(from)}`,
        // The managed sudo rule names the group, so it has to follow the rename or it stops applying.
        `if [ -f ${q(oldFile)} ]; then`,
        `  sed "s/^%${from} /%${to} /; s/the group ${from}\\./the group ${to}./" ${q(oldFile)} > ${q(newFile)}.tmp`,
        `  chmod 0440 ${q(newFile)}.tmp`,
        `  if visudo -cf ${q(newFile)}.tmp; then install -m 0440 -o root -g root ${q(newFile)}.tmp ${q(newFile)}; rm -f ${q(oldFile)}; fi`,
        `  rm -f ${q(newFile)}.tmp`,
        'fi',
        `echo "The group ${from} is now called ${to}. Folders it owns follow the rename automatically."`,
      ].join('\n');
    }

    // Turns note copies into a team folder: one group can read and update them, new files keep that
    // group (setgid), and copies already saved in the login user's home move in.
    case 'notesShare': {
      const group = checkGroup(spec.group);
      const from = String(spec.from || '');
      if (!FOLDER.test(from) || !from.endsWith('/.server-explorer/notes') || from.includes('..')) {
        throw new Error('Invalid notes folder');
      }
      return [
        `getent group ${q(group)} >/dev/null 2>&1 || { echo "There is no group called ${group}."; exit 1; }`,
        'D=/srv/server-explorer/notes',
        'mkdir -p "$D"',
        `chown root:${q(group)} /srv/server-explorer "$D"`,
        'chmod 0750 /srv/server-explorer',
        'chmod 2770 "$D"',
        // Explicit ifs, not `[ -f ] && mv`: under set -e a skipped last file would fail the loop.
        `if [ -d ${q(from)} ]; then for f in ${q(from)}/*.md; do if [ -f "$f" ]; then mv -n -- "$f" "$D"/; fi; done; fi`,
        `for f in "$D"/*.md; do if [ -f "$f" ]; then chgrp ${q(group)} "$f"; chmod 0660 "$f"; fi; done`,
        `echo "Notes on this server are now shared with the group ${group} in $D."`,
      ].join('\n');
    }

    case 'groupFolder': {
      const name = checkGroup(spec.name);
      const dir = String(spec.path || '');
      if (dir.includes('..') || !HOME_PATH.test(dir)) throw new Error('Only folders inside /home can be shared with a group.');
      const grant = spec.action !== 'revoke';
      // find skips symlinks (no -type l) and -xdev stays on one filesystem, so a link inside the
      // folder cannot drag the change out to /etc or another mount.
      const walk = (type, cmd) => `find ${q(dir)} -xdev -type ${type} -exec ${cmd} {} +`;
      const lines = [
        `[ -d ${q(dir)} ] || { echo "There is no folder at ${dir}."; exit 1; }`,
        `getent group ${q(name)} >/dev/null 2>&1 || { echo "There is no group called ${name}."; exit 1; }`,
      ];
      if (grant) {
        lines.push(
          walk('d', `chgrp ${q(name)}`),
          // setgid on directories is what makes new files keep the group, so access sticks.
          walk('d', 'chmod g+rwxs'),
          walk('f', `chgrp ${q(name)}`),
          walk('f', 'chmod g+rw'),
          `echo "Everyone in ${name} can now read and write ${dir}, including anything added later."`
        );
      } else {
        lines.push(
          walk('d', 'chmod g-ws'),
          walk('f', 'chmod g-w'),
          `echo "${name} can no longer write ${dir}. The folder keeps the group, so sharing it again is one click."`
        );
      }
      return lines.join('\n');
    }

    case 'aiCommand': {
      // A command the AI assistant proposed and the user approved in the chat. The policy layer in
      // ai/tools.js already ruled on it; this second check is here so a command can't reach `sh`
      // through a spec built somewhere else, the same way PROTECTED_SERVICES guards the UI kinds.
      if (typeof spec.command !== 'string' || !spec.command.trim() || spec.command.length > 200000) throw new Error('Invalid command');
      const mode = spec.mode || 'readonly';
      const gate = require('./ai/policy').commandGate(spec.command, mode);
      if (!gate.ok) throw new Error(`Blocked by the "${mode}" security mode: ${gate.reason}`);
      return spec.command;
    }

    default:
      throw new Error('Unknown job');
  }
}

function buildScript(spec) {
  const footer = RAW_OUTPUT_KINDS.has(spec.kind) ? '' : '\necho\necho "Done."';
  return `${PRELUDE}\n${scriptBody(spec)}${footer}\n`;
}

function explainFailure(spec, output) {
  if (spec.kind !== 'certbot') return undefined;
  if (/DNS problem|NXDOMAIN|no valid A records|check that a DNS record exists/i.test(output)) {
    return "Let's Encrypt couldn't verify the domain: its DNS doesn't point to this server yet. Point the domain's A record to this server, wait a bit, and try again.";
  }
  if (/Timeout during connect|Connection refused|firewall/i.test(output)) {
    return "Let's Encrypt couldn't reach this server on port 80. Make sure ports 80 and 443 are open in your firewall or your hosting provider's security settings.";
  }
  if (/too many (certificates|failed authorizations)|rateLimited/i.test(output)) {
    return "Let's Encrypt's rate limit was reached for this domain. Wait an hour and try again.";
  }
  if (/rejectedIdentifier|Invalid identifiers|Cannot issue for/i.test(output)) {
    return "Let's Encrypt can't issue a certificate for this domain name.";
  }
  return undefined;
}

// Starts a job. Resolves (with a cancel handle) once it's running; output and the result arrive via the callbacks.
// Without root, the script runs through sudo: `sudo -S` with a password, or `sudo -n` without one
// (which fails fast so the UI can ask for the password). Docker jobs skip sudo when the user can
// already talk to Docker.
async function startJob(serverId, spec, password, { onData, onExit }) {
  const script = buildScript(spec);
  const who = await ssh.exec(serverId, 'id -u', null, 15000);
  const isRoot = who.stdout.trim() === '0';
  // Checked here because this is the only point that sees the uid before sudo would mask it:
  // inside the script a sudo user is already root, so the script itself cannot tell them apart.
  if (ROOT_ONLY_KINDS.has(spec.kind) && !isRoot) {
    throw new Error('Only a connection signed in as root can sign other people out.');
  }
  // AI commands only use sudo when they ask for root.
  let useSudo = !isRoot && (spec.kind !== 'aiCommand' || spec.asRoot === true);
  if (useSudo && DOCKER_KINDS.has(spec.kind)) {
    const probe = await ssh.exec(serverId, 'docker ps -q >/dev/null 2>&1', null, 20000);
    useSudo = probe.code !== 0;
  }

  let command = `sh -c ${q(script)}`;
  let input = '';
  if (useSudo && password) {
    command = `sudo -S -p '' ${command}`;
    input = `${password}\n`;
  } else if (useSudo) {
    command = `sudo -n ${command}`;
  }

  let tail = '';
  // Resolves with { cancel } so a running job can be stopped.
  return ssh.execStream(serverId, command, input, {
    onData: (chunk) => {
      tail = (tail + chunk).slice(-12000);
      onData(chunk);
    },
    onExit: ({ code, stderrHead }) => {
      const result = { code };
      if (useSudo && code !== 0) {
        if (/not in the sudoers|is not allowed to run sudo|may not run sudo/i.test(stderrHead)) {
          result.error = "This user isn't allowed to use sudo. Log in as root or as a user with sudo rights.";
        } else if (/sudo: .*not found|sudo: not found/i.test(stderrHead)) {
          result.error = "sudo isn't installed on this server, so only root can do this.";
        } else if (/Sorry, try again|incorrect password|password is required|no password was provided/i.test(stderrHead.slice(0, 600))) {
          result.needPassword = true;
        }
      }
      if (code !== 0 && !result.needPassword && !result.error) result.error = explainFailure(spec, tail);
      onExit(result);
    },
  });
}

module.exports = { startJob, buildScript };
