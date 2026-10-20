// Software catalog and package search. Install/remove scripts are run by jobs.js.
const ssh = require('./ssh');

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const SEARCH_TERM = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,60}$/;

const DOCKER_SCRIPT = 'need_curl && curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh';
const DOCKER_PACKAGES = 'docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker.io docker-compose-v2';

// install/remove map package manager -> shell commands ('*' = any), using the helpers in
// jobs.js (pkg_install, pkg_remove, start_service...). `detect` is a shell condition
// (default: the binary exists). Items without `remove` can't be uninstalled here.
const CATALOG = [
  {
    id: 'docker',
    name: 'Docker',
    category: 'Containers',
    bin: 'docker',
    description: "Run apps in containers. Installed with Docker's official install script.",
    install: { apt: DOCKER_SCRIPT, dnf: DOCKER_SCRIPT, apk: 'pkg_install docker docker-cli-compose', pacman: 'pkg_install docker docker-compose' },
    after: [
      'start_service docker',
      'if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != root ]; then usermod -aG docker "$SUDO_USER" && echo "Added $SUDO_USER to the docker group."; fi',
    ].join('\n'),
    remove: { apt: `pkg_remove ${DOCKER_PACKAGES}`, dnf: `pkg_remove ${DOCKER_PACKAGES}`, apk: 'pkg_remove docker docker-cli-compose', pacman: 'pkg_remove docker docker-compose' },
    note: 'Disconnect and connect again so your user can run docker without sudo.',
    keepsData: 'Containers, images and volumes in /var/lib/docker are kept.',
  },
  {
    id: 'nginx',
    name: 'Nginx',
    category: 'Web server',
    bin: 'nginx',
    description: 'Fast web server and reverse proxy.',
    install: { '*': 'pkg_install nginx' },
    after: 'start_service nginx',
    remove: { '*': 'pkg_remove nginx nginx-common nginx-core' },
    keepsData: 'Your site configuration in /etc/nginx is kept.',
  },
  {
    id: 'apache',
    name: 'Apache',
    category: 'Web server',
    bin: 'apache2',
    detect: 'has apache2 || has httpd',
    description: 'The classic Apache HTTP web server.',
    install: { apt: 'pkg_install apache2', dnf: 'pkg_install httpd', apk: 'pkg_install apache2', pacman: 'pkg_install apache' },
    after: 'case $PM in apt|apk) start_service apache2 ;; *) start_service httpd ;; esac',
    remove: { apt: 'pkg_remove apache2', dnf: 'pkg_remove httpd', apk: 'pkg_remove apache2', pacman: 'pkg_remove apache' },
    keepsData: 'Configuration files are kept.',
  },
  {
    id: 'nodejs',
    name: 'Node.js',
    category: 'Runtime',
    bin: 'node',
    description: 'JavaScript runtime, current LTS version from NodeSource (includes npm).',
    install: {
      apt: 'need_curl && curl -fsSL https://deb.nodesource.com/setup_lts.x -o /tmp/nodesource_setup.sh && bash /tmp/nodesource_setup.sh && apt-get install -y -q nodejs',
      dnf: 'need_curl && curl -fsSL https://rpm.nodesource.com/setup_lts.x -o /tmp/nodesource_setup.sh && bash /tmp/nodesource_setup.sh && $PM install -y nodejs',
      apk: 'pkg_install nodejs npm',
      pacman: 'pkg_install nodejs npm',
    },
    remove: { '*': 'pkg_remove nodejs npm' },
  },
  {
    id: 'pm2',
    name: 'PM2',
    category: 'Runtime',
    bin: 'pm2',
    description: 'Keeps Node.js apps running and restarts them if they crash. Needs Node.js.',
    install: { '*': 'command -v npm >/dev/null 2>&1 || { echo "PM2 needs Node.js. Install Node.js first."; exit 1; }\nnpm install -g pm2' },
    remove: { '*': 'npm uninstall -g pm2' },
  },
  {
    id: 'python',
    name: 'Python 3',
    category: 'Runtime',
    bin: 'python3',
    description: 'Python 3 with pip and virtual environments.',
    install: {
      apt: 'pkg_install python3 python3-pip python3-venv',
      dnf: 'pkg_install python3 python3-pip',
      apk: 'pkg_install python3 py3-pip',
      pacman: 'pkg_install python python-pip',
    },
    // No uninstall: many system tools depend on Python.
  },
  {
    id: 'php',
    name: 'PHP',
    category: 'Runtime',
    bin: 'php',
    description: 'PHP with PHP-FPM and common extensions (MySQL, curl, mbstring, XML, zip).',
    install: {
      apt: 'pkg_install php-cli php-fpm php-mysql php-curl php-mbstring php-xml php-zip',
      dnf: 'pkg_install php-cli php-fpm php-mysqlnd php-mbstring php-xml',
      apk: 'pkg_install php php-fpm',
      pacman: 'pkg_install php php-fpm',
    },
    remove: {
      apt: "pkg_remove $(dpkg-query -W -f='${Package}\\n' 'php*' 2>/dev/null)",
      dnf: "pkg_remove $(rpm -qa --qf '%{NAME}\\n' 'php*')",
      apk: 'pkg_remove php php-fpm',
      pacman: 'pkg_remove php php-fpm',
    },
    keepsData: 'Configuration files are kept.',
  },
  {
    id: 'mysql',
    name: 'MySQL',
    category: 'Database',
    bin: 'mysql',
    detect: 'has mysqld && ! mysqld --version 2>/dev/null | grep -qi mariadb',
    description: 'MySQL database server.',
    install: { apt: 'pkg_install mysql-server', dnf: 'pkg_install mysql-server' },
    after: 'case $PM in apt) start_service mysql ;; *) start_service mysqld ;; esac',
    remove: {
      apt: "pkg_remove mysql-server $(dpkg-query -W -f='${Package}\\n' 'mysql-server-*' 2>/dev/null)",
      dnf: 'pkg_remove mysql-server',
    },
    keepsData: 'Your databases in /var/lib/mysql are kept.',
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    category: 'Database',
    bin: 'mariadb',
    detect: 'has mariadbd || { has mysqld && mysqld --version 2>/dev/null | grep -qi mariadb; }',
    description: 'MariaDB database server, a drop-in replacement for MySQL.',
    install: { apt: 'pkg_install mariadb-server', dnf: 'pkg_install mariadb-server', apk: 'pkg_install mariadb mariadb-client' },
    after: 'start_service mariadb',
    remove: { apt: 'pkg_remove mariadb-server', dnf: 'pkg_remove mariadb-server', apk: 'pkg_remove mariadb mariadb-client' },
    keepsData: 'Your databases in /var/lib/mysql are kept.',
  },
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    category: 'Database',
    bin: 'psql',
    detect: 'has postgres || has postgresql-setup || ls /usr/lib/postgresql/*/bin/postgres >/dev/null 2>&1',
    description: 'PostgreSQL database server.',
    install: {
      apt: 'pkg_install postgresql',
      dnf: 'pkg_install postgresql-server && { postgresql-setup --initdb || true; }',
      apk: 'pkg_install postgresql',
    },
    after: 'start_service postgresql',
    remove: {
      apt: "pkg_remove postgresql $(dpkg-query -W -f='${Package}\\n' 'postgresql-[0-9]*' 2>/dev/null)",
      dnf: 'pkg_remove postgresql-server',
      apk: 'pkg_remove postgresql',
    },
    keepsData: 'Your databases are kept.',
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'Database',
    bin: 'redis-server',
    description: 'In-memory cache and key-value store.',
    install: { apt: 'pkg_install redis-server', dnf: 'pkg_install redis', apk: 'pkg_install redis', pacman: 'pkg_install redis' },
    after: 'case $PM in apt) start_service redis-server ;; *) start_service redis ;; esac',
    remove: { apt: 'pkg_remove redis-server redis-tools', '*': 'pkg_remove redis' },
    keepsData: 'Configuration and saved data are kept.',
  },
  {
    id: 'certbot',
    name: 'Certbot',
    category: 'Tools',
    bin: 'certbot',
    description: "Free HTTPS certificates from Let's Encrypt.",
    install: { apt: 'pkg_install certbot python3-certbot-nginx', '*': 'pkg_install certbot' },
    remove: { apt: 'pkg_remove certbot python3-certbot-nginx', '*': 'pkg_remove certbot' },
    keepsData: 'Existing certificates in /etc/letsencrypt are kept.',
  },
  {
    id: 'git',
    name: 'Git',
    category: 'Tools',
    bin: 'git',
    description: 'Version control, for pulling your code onto the server.',
    install: { '*': 'pkg_install git' },
    remove: { '*': 'pkg_remove git' },
  },
  {
    id: 'ufw',
    name: 'UFW firewall',
    category: 'Tools',
    bin: 'ufw',
    description: "Simple firewall. Installing it doesn't turn it on.",
    install: { apt: 'pkg_install ufw', pacman: 'pkg_install ufw', apk: 'pkg_install ufw' },
    remove: { '*': 'pkg_remove ufw' },
  },
  {
    id: 'fail2ban',
    name: 'Fail2ban',
    category: 'Tools',
    bin: 'fail2ban-client',
    description: 'Blocks IP addresses that keep failing to log in.',
    install: { apt: 'pkg_install fail2ban', dnf: '{ is_installed epel-release || pkg_install epel-release || true; } && pkg_install fail2ban', '*': 'pkg_install fail2ban' },
    after: 'start_service fail2ban',
    remove: { '*': 'pkg_remove fail2ban' },
    keepsData: 'Configuration files are kept.',
  },
  {
    id: 'htop',
    name: 'htop',
    category: 'Tools',
    bin: 'htop',
    description: 'Interactive process viewer for the terminal.',
    install: { '*': 'pkg_install htop' },
    remove: { '*': 'pkg_remove htop' },
  },
];

const CATALOG_BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

async function searchPackages(serverId, query) {
  const term = String(query || '').trim();
  if (!SEARCH_TERM.test(term)) return { manager: null, results: [] };
  const script = `
if command -v apt-cache >/dev/null 2>&1; then
  echo @@apt@@; apt-cache search --names-only -- ${q(term)} 2>/dev/null | head -n 400
  echo @@lists@@; ls /var/lib/apt/lists 2>/dev/null | grep -c '_Packages' || true
elif command -v dnf >/dev/null 2>&1; then echo @@dnf@@; dnf search -q ${q(term)} 2>/dev/null | head -n 400
elif command -v yum >/dev/null 2>&1; then echo @@dnf@@; yum search -q ${q(term)} 2>/dev/null | head -n 400
elif command -v apk >/dev/null 2>&1; then echo @@apk@@; apk search -d ${q(term)} 2>/dev/null | head -n 400
elif command -v pacman >/dev/null 2>&1; then echo @@pacman@@; pacman -Ss ${q(term)} 2>/dev/null | head -n 800
fi
`;
  const res = await ssh.runScript(serverId, script, 60000);
  const lines = res.stdout.split('\n');
  const marker = lines.findIndex((l) => /^@@\w+@@$/.test(l));
  if (marker < 0) return { manager: null, results: [] };
  const manager = lines[marker].slice(2, -2);
  const body = [];
  let listsCount = null;
  for (let i = marker + 1; i < lines.length; i++) {
    if (lines[i] === '@@lists@@') {
      listsCount = Number(lines[i + 1]) || 0;
      break;
    }
    body.push(lines[i]);
  }

  const results = [];
  if (manager === 'apt') {
    for (const l of body) {
      const m = l.match(/^(\S+) - (.*)$/);
      if (m) results.push({ name: m[1], description: m[2] });
    }
  } else if (manager === 'dnf') {
    const seen = new Set();
    for (const l of body) {
      const m = l.match(/^\s*([^\s:=]+)\.(\w+)\s*:?\s+(.*)$/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        results.push({ name: m[1], description: m[3].replace(/^:\s*/, '') });
      }
    }
  } else if (manager === 'apk') {
    for (const l of body) {
      const m = l.match(/^(.+)-(\d[^-]*-r\d+) - (.*)$/);
      if (m) results.push({ name: m[1], version: m[2], description: m[3] });
    }
  } else if (manager === 'pacman') {
    for (let i = 0; i < body.length; i++) {
      const m = body[i].match(/^(\S+)\/(\S+) (\S+)/);
      if (m) results.push({ name: m[2], version: m[3], description: (body[i + 1] || '').trim() });
    }
  }

  const lower = term.toLowerCase();
  const rank = (name) => (name === lower ? 0 : name.startsWith(lower) ? 1 : 2);
  results.sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return { manager, results: results.slice(0, 100), stale: manager === 'apt' && listsCount === 0 };
}

module.exports = { CATALOG, CATALOG_BY_ID, searchPackages };
