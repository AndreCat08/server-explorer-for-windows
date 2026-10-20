// Websites: reads Nginx site configs from the server, and checks where a domain's DNS points.
const dns = require('dns').promises;
const net = require('net');
const { runScript } = require('./ssh');

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const SITES_SCRIPT = `
export PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"
if command -v nginx >/dev/null 2>&1; then echo @@nginx@@; fi
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [ -f "$f" ] || continue
  echo "@@file@@ $(readlink -f "$f" 2>/dev/null || echo "$f")"
  if [ -r "$f" ]; then cat "$f"; echo; else echo @@unreadable@@; fi
done
echo @@certs@@
if command -v certbot >/dev/null 2>&1; then echo certbot=yes; certbot certificates 2>&1; else echo certbot=no; fi
`;

function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      let out = '';
      let quote = null;
      for (const ch of line) {
        if (quote) {
          out += ch;
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
          out += ch;
        } else if (ch === '#') {
          break;
        } else {
          out += ch;
        }
      }
      return out;
    })
    .join('\n');
}

// Returns the body of every `server { ... }` block (upstream `server host:port;` lines don't match).
function serverBlocks(text) {
  const blocks = [];
  const re = /\bserver\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < text.length && depth; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    blocks.push(text.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return blocks;
}

// Certificates as Certbot reports them. Reading them needs root, so an access error means "unknown".
function parseCerts(lines) {
  if (!lines || !lines.length) return { certbot: false, readable: true, list: [] };
  if (lines[0] !== 'certbot=yes') return { certbot: false, readable: true, list: [] };
  const body = lines.slice(1);
  const text = body.join('\n');
  if (!/Certificate Name:/.test(text) && /must be run as root|need to be root|Permission denied|denied/i.test(text)) {
    return { certbot: true, readable: false, list: [] };
  }
  const list = [];
  let current = null;
  for (const line of body) {
    const name = line.match(/^\s*Certificate Name:\s*(.+)$/);
    if (name) {
      current = { name: name[1].trim(), domains: [], expiry: '', days: null, invalid: false, path: '' };
      list.push(current);
      continue;
    }
    if (!current) continue;
    const domains = line.match(/^\s*Domains:\s*(.+)$/);
    if (domains) {
      current.domains = domains[1].trim().split(/\s+/).filter(Boolean);
      continue;
    }
    const expiry = line.match(/^\s*Expiry Date:\s*(\S+ \S+)\s*(?:\(([^)]*)\))?/);
    if (expiry) {
      current.expiry = expiry[1];
      const days = (expiry[2] || '').match(/(-?\d+)\s*day/);
      current.days = days ? Number(days[1]) : null;
      current.invalid = /INVALID|EXPIRED/i.test(expiry[2] || '');
      continue;
    }
    const path = line.match(/^\s*Certificate Path:\s*(.+)$/);
    if (path) current.path = path[1].trim();
  }
  return { certbot: true, readable: true, list };
}

async function list(serverId) {
  const res = await runScript(serverId, SITES_SCRIPT);
  const files = [];
  let nginx = false;
  let current = null;
  let certLines = null;
  for (const line of res.stdout.split('\n')) {
    if (line === '@@certs@@') {
      certLines = [];
      current = null;
    } else if (certLines) certLines.push(line);
    else if (line === '@@nginx@@') nginx = true;
    else if (line.startsWith('@@file@@ ')) files.push((current = { path: line.slice(9), text: '', unreadable: false }));
    else if (current && line === '@@unreadable@@') current.unreadable = true;
    else if (current) current.text += `${line}\n`;
  }

  // Blocks with the same server names are one website (e.g. Certbot's port 80 redirect + 443 block).
  const sites = new Map();
  for (const file of files) {
    if (file.unreadable) continue;
    for (const block of serverBlocks(stripComments(file.text))) {
      const names = ((block.match(/\bserver_name\s+([^;]+);/) || [])[1] || '').trim().split(/\s+/).filter(Boolean);
      const listens = [...block.matchAll(/\blisten\s+([^;]+);/g)].map((x) => x[1]);
      const key = names.length ? [...names].sort().join(' ') : `(no name) ${file.path}`;
      if (!sites.has(key)) sites.set(key, { names, files: [], https: false, target: null });
      const site = sites.get(key);
      if (!site.files.includes(file.path)) site.files.push(file.path);
      if (listens.some((l) => /\b443\b|\bssl\b/.test(l)) || /\bssl_certificate\s/.test(block)) site.https = true;
      const proxy = block.match(/\bproxy_pass\s+([^;]+);/);
      const root = block.match(/\broot\s+([^;]+);/);
      if (!site.target && proxy) site.target = { type: 'proxy', value: proxy[1].trim() };
      else if (!site.target && root) site.target = { type: 'folder', value: root[1].trim() };
    }
  }

  const result = [...sites.values()].map((s) => {
    const domains = s.names.filter((n) => DOMAIN.test(n));
    return {
      names: s.names,
      domains,
      primary: domains[0] || '',
      aliases: domains.slice(1),
      file: s.files[0],
      files: s.files,
      https: s.https,
      target: s.target,
      canHttps: domains.length > 0,
    };
  });
  result.sort((a, b) => Number(!a.primary) - Number(!b.primary) || a.primary.localeCompare(b.primary));
  return { nginx, sites: result, unreadable: files.filter((f) => f.unreadable).map((f) => f.path), certs: parseCerts(certLines) };
}

// Where does the domain point, and is that this server? Resolved from the PC.
async function dnsCheck(domain, serverHost) {
  const serverIps = net.isIP(serverHost) ? [serverHost] : await dns.resolve4(serverHost).catch(() => []);
  const domainIps = await dns.resolve4(domain).catch(() => []);
  return { domainIps, serverIps, matches: domainIps.some((ip) => serverIps.includes(ip)) };
}

module.exports = { list, dnsCheck };
