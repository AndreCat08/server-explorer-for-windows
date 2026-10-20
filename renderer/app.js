'use strict';
/* global api, Terminal, FitAddon, ICONS */
// `api` is the global exposed by preload.js via contextBridge (it can't be redeclared here).
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- DOM helpers (text is always set via textContent, so remote data can't inject HTML) ----------

const PROP_KEYS = new Set(['hidden', 'value', 'checked', 'disabled', 'title', 'type', 'placeholder', 'spellcheck', 'min', 'max']);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (PROP_KEYS.has(key)) el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function icon(name, extra = '') {
  const el = document.createElement('span');
  el.className = `icon ${extra}`;
  el.innerHTML = ICONS[name] || '';
  return el;
}

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    year: sameYear ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function elapsedSeconds(s) {
  const [days, rest] = s.includes('-') ? s.split('-') : [0, s];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function fmtDuration(sec) {
  const d = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  if (m) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

function parseSize(s) {
  const m = String(s).match(/([\d.]+)\s*([kMGT]?B)/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()] || 1;
  return Number(m[1]) * mult;
}

const ratio = (a, b) => (b ? a / b : 0);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentPath = (p) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';

function groupBy(list, key) {
  const out = {};
  for (const item of list) (out[item[key]] ||= []).push(item);
  return out;
}

function meter(value) {
  const level = value >= 0.9 ? 'crit' : value >= 0.75 ? 'warn' : '';
  const width = `${Math.min(100, Math.max(0, value * 100)).toFixed(1)}%`;
  return h('div', { class: 'meter' }, h('div', { class: `meter-fill ${level}`, style: { width } }));
}

function loadingEl(text = 'Loading…') {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text);
}

function emptyState(iconName, title, text, action) {
  return h(
    'div',
    { class: 'state-card', style: { margin: '40px auto' } },
    h('div', { class: 'big-icon' }, icon(iconName)),
    h('h2', {}, title),
    text ? h('p', {}, text) : null,
    action || null
  );
}

function errorState(message, retry) {
  return h(
    'div',
    { class: 'state-card', style: { margin: '40px auto' } },
    h('div', { class: 'big-icon' }, icon('alert')),
    h('h2', {}, 'Something went wrong'),
    h('p', { class: 'error-text' }, message),
    retry ? h('button', { class: 'btn', onclick: retry }, icon('refresh'), 'Try Again') : null
  );
}

function notice(text, type = '') {
  return h('div', { class: `notice ${type}` }, icon('alert'), h('div', {}, text));
}

function statCard(label, value, detail, extra) {
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value', title: value }, value),
    detail ? h('div', { class: 'stat-detail', title: detail }, detail) : null,
    extra || null
  );
}

function section(title, extras, right, content) {
  return h(
    'div',
    { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', {}, title), extras, h('div', { class: 'spacer' }), right),
    content
  );
}

function searchInput(placeholder, value, onInput) {
  return h(
    'div',
    { class: 'search' },
    icon('search'),
    h('input', {
      class: 'input',
      type: 'search',
      placeholder,
      value: value || '',
      spellcheck: false,
      oninput: (e) => onInput(e.target.value),
    })
  );
}

// ---------- Tables ----------

// Firewall rule limits, kept in step with the checks the job scripts apply on the server side.
const MAX_PORT_SOURCES = 10;
const RULE_COMMENT = /^[^\n\r'"\\`$]{0,120}$/;

// A single IPv4/IPv6 address or CIDR block, range-checked so 999.1.1.1 and a /64 on IPv4 fail here
// rather than on the server.
function isAddress(entry) {
  const v4 = entry.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (v4) {
    if (v4.slice(1, 5).some((n) => Number(n) > 255)) return false;
    return v4[5] === undefined || Number(v4[5]) <= 32;
  }
  const v6 = entry.includes(':') ? entry.match(/^[0-9A-Fa-f:]{2,45}(?:\/(\d{1,3}))?$/) : null;
  if (v6) return v6[1] === undefined || Number(v6[1]) <= 128;
  return false;
}

function sortRows(rows, columns, sort) {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col) return rows;
  const get = col.sortValue || ((r) => r[col.key]);
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    const cmp =
      typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    return cmp * sort.dir;
  });
}

function dataTable({ columns, rows, sort, onSort, empty = 'Nothing to show', rowProps }) {
  const head = h(
    'tr',
    {},
    columns.map((c) => {
      const sortable = onSort && c.sortable !== false;
      const active = sort && sort.key === c.key;
      return h(
        'th',
        {
          class: `${sortable ? 'sortable' : ''} ${c.num ? 'num' : ''}`,
          style: c.width ? { width: c.width } : null,
          onclick: sortable ? () => onSort(c.key) : null,
        },
        c.label,
        active ? h('span', { class: 'arrow' }, sort.dir > 0 ? '↑' : '↓') : null
      );
    })
  );
  const body = rows.length
    ? rows.map((r) =>
        h(
          'tr',
          rowProps ? rowProps(r) : null,
          columns.map((c) =>
            h(
              'td',
              { class: c.class || (c.num ? 'num' : ''), title: c.title ? c.title(r) : null },
              c.render ? c.render(r) : r[c.key] ?? ''
            )
          )
        )
      )
    : h('tr', {}, h('td', { colspan: columns.length, class: 'empty' }, empty));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, head), h('tbody', {}, body)));
}

// A sortable table with a search box; only the table re-renders while typing (keeps focus).
function tableSection({ ui, columns, rows, searchKeys, placeholder, empty, extraFilter, onCount }) {
  const host = h('div');
  const draw = () => {
    const q = (ui.search || '').trim().toLowerCase();
    let list = extraFilter ? rows.filter(extraFilter) : rows;
    if (q) list = list.filter((r) => searchKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(q)));
    list = sortRows(list, columns, ui.sort);
    host.replaceChildren(
      dataTable({
        columns,
        rows: list,
        sort: ui.sort,
        empty: q ? 'No matches' : empty,
        onSort: (key) => {
          ui.sort = ui.sort?.key === key ? { key, dir: -ui.sort.dir } : { key, dir: 1 };
          draw();
        },
      })
    );
    onCount?.(list.length);
  };
  const search = searchInput(placeholder, ui.search, (v) => {
    ui.search = v;
    draw();
  });
  return { host, search, draw };
}

// ---------- Toasts & modals ----------

function toast(message, { type = 'info', action, busy = false } = {}) {
  const el = h('div', { class: `toast ${type}` });
  const close = () => el.remove();
  el.append(
    busy ? h('div', { class: 'spinner' }) : icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'server'),
    h('div', { class: 'msg' }, message)
  );
  if (action) {
    el.append(
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            action.run();
            close();
          },
        },
        action.label
      )
    );
  }
  if (!busy) el.append(h('button', { class: 'icon-btn', title: 'Dismiss', onclick: close }, icon('x')));
  $('#toasts').append(el);
  if (!busy) setTimeout(close, type === 'error' ? 9000 : action ? 8000 : 4000);
  return { close };
}

// Modals stack, so a password prompt can open on top of an editor or log window.
// Escape closes the top one.
const modalStack = [];
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && modalStack.length) {
      e.stopPropagation();
      modalStack[modalStack.length - 1]();
    }
  },
  true
);

// `canClose` can veto closing (Escape, backdrop, ×) while work is in progress.
function openModal({ title, subtitle, body, footer, wide = false, onClose, canClose }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h('div', { class: `modal ${wide ? 'wide' : ''}` });
  let closed = false;
  const close = (force) => {
    if (closed) return;
    if (force !== true && canClose && !canClose()) return;
    closed = true;
    backdrop.remove();
    modalStack.splice(modalStack.indexOf(close), 1);
    onClose?.();
  };
  modal.append(
    h(
      'div',
      { class: 'modal-head' },
      h('h2', {}, title, subtitle ? h('div', { class: 'sub' }, subtitle) : null),
      h('button', { class: 'icon-btn', title: 'Close', onclick: () => close() }, icon('x'))
    ),
    h('div', { class: 'modal-body' }, body)
  );
  if (footer) modal.append(h('div', { class: 'modal-foot' }, footer));
  backdrop.append(modal);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
  modalStack.push(close);
  return close;
}

function confirmDialog({ title, message, confirmText = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h(
      'button',
      {
        class: `btn ${danger ? 'danger solid' : 'primary'}`,
        onclick: () => {
          result = true;
          close();
        },
      },
      confirmText
    );
    const close = openModal({
      title,
      body: h('p', {}, message),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), ok],
      onClose: () => resolve(result),
    });
    setTimeout(() => ok.focus(), 30);
  });
}

function promptDialog({ title, message, label, value = '', type = 'text', confirmText = 'OK', checkboxLabel }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { class: 'input', type, value, spellcheck: false });
    const checkbox = checkboxLabel ? h('input', { type: 'checkbox' }) : null;
    const submit = () => {
      result = { value: input.value, checked: checkbox ? checkbox.checked : false };
      close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const body = h(
      'div',
      {},
      message ? h('p', {}, message) : null,
      h('div', { class: 'field' }, label ? h('label', {}, label) : null, input),
      checkbox ? h('label', { class: 'checkbox', style: { marginTop: '10px' } }, checkbox, checkboxLabel) : null
    );
    const close = openModal({
      title,
      body,
      footer: [
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: submit }, confirmText),
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => {
      input.focus();
      if (type === 'text' && value) {
        const dot = value.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : value.length);
      }
    }, 30);
  });
}

const AI_MODES = [
  ['readonly', 'Read-only'],
  ['normal', 'Normal'],
  ['full', 'Full'],
];
const AI_MODE_LABELS = Object.fromEntries(AI_MODES);

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// The certificate email is remembered on this PC for convenience.
const storedEmail = {
  get() {
    try {
      return localStorage.getItem('certbotEmail') || '';
    } catch {
      return '';
    }
  },
  set(value) {
    try {
      localStorage.setItem('certbotEmail', value);
    } catch {
      // Storage unavailable: nothing to remember.
    }
  },
};

// Picks the most useful line from a failed job's output for an error message.
function summarizeFailure(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== 'Done.');
  return (
    lines.find((l) => /\[emerg\]/.test(l)) ||
    [...lines].reverse().find((l) => /error|failed|denied|not found|invalid/i.test(l)) ||
    lines[lines.length - 1] ||
    ''
  );
}

// Minimal, safe Markdown for AI replies: code blocks, lists, headings, **bold** and `code`.
function renderMarkdown(text) {
  const inline = (line) => {
    const nodes = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) nodes.push(line.slice(last, m.index));
      nodes.push(m[0].startsWith('`') ? h('code', {}, m[0].slice(1, -1)) : h('strong', {}, m[0].slice(2, -2)));
      last = m.index + m[0].length;
    }
    if (last < line.length) nodes.push(line.slice(last));
    return nodes;
  };
  const withBreaks = (lines) => lines.flatMap((line, i) => (i ? [h('br'), ...inline(line)] : inline(line)));
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const isTable = (lines) =>
    lines.length >= 2 &&
    lines[0].includes('|') &&
    /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[1]) &&
    cells(lines[0]).length === cells(lines[1]).length;
  const table = (lines) => {
    const align = cells(lines[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
    const cell = (tag, text, i) => h(tag, align[i] ? { style: { textAlign: align[i] } } : {}, inline(text));
    return h(
      'div',
      { class: 'ai-table-wrap' },
      h(
        'table',
        { class: 'ai-table' },
        h('thead', {}, h('tr', {}, cells(lines[0]).map((c, i) => cell('th', c, i)))),
        h('tbody', {}, lines.slice(2).map((l) => h('tr', {}, cells(l).map((c, i) => cell('td', c, i)))))
      )
    );
  };
  const out = document.createDocumentFragment();
  text.split('```').forEach((part, i) => {
    if (i % 2 === 1) {
      const newline = part.indexOf('\n');
      out.append(h('pre', { class: 'ai-code' }, (newline >= 0 ? part.slice(newline + 1) : part).replace(/\n$/, '')));
      return;
    }
    const plain = (lines) => {
      if (!lines.length) return;
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        const tag = /^\s*\d+\./.test(lines[0]) ? 'ol' : 'ul';
        out.append(h(tag, {}, lines.map((l) => h('li', {}, inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))))));
      } else if (/^#{1,4}\s/.test(lines[0])) {
        out.append(h('h4', {}, inline(lines[0].replace(/^#+\s*/, ''))));
        if (lines.length > 1) plain(lines.slice(1));
      } else {
        out.append(h('p', {}, withBreaks(lines)));
      }
    };
    for (const block of part.split(/\n{2,}/)) {
      if (!block.trim()) continue;
      let lines = block.replace(/^\n+|\n+$/g, '').split('\n');
      // A table can start partway through a block (e.g. after a heading line).
      while (lines.length) {
        const start = lines.findIndex((_, i) => isTable(lines.slice(i)));
        if (start < 0) break;
        plain(lines.slice(0, start));
        let end = start + 2;
        while (end < lines.length && lines[end].includes('|')) end += 1;
        out.append(table(lines.slice(start, end)));
        lines = lines.slice(end);
      }
      plain(lines);
    }
  });
  return out;
}

// ---------- App state & sidebar ----------

const state = { servers: [], selectedId: null, views: new Map(), sshHosts: [] };
const terminals = new Map(); // termId -> ServerView
const installJobs = new Map(); // jobId -> { data(chunk), exit(result) }
const aiChats = new Map(); // chatId -> ServerView

const serverById = (id) => state.servers.find((s) => s.id === id);

function renderSidebar() {
  const list = $('#server-list');
  list.replaceChildren();
  if (!state.servers.length) {
    list.append(h('li', { class: 'empty-hint' }, 'No servers yet. Click + to add one.'));
    return;
  }
  for (const s of state.servers) {
    const view = state.views.get(s.id);
    list.append(
      h(
        'li',
        {
          class: `server-item ${s.id === state.selectedId ? 'selected' : ''}`,
          title: `${s.username}@${s.host}:${s.port}`,
          onclick: () => selectServer(s.id),
          oncontextmenu: (e) => {
            e.preventDefault();
            openServerForm(s);
          },
        },
        icon('server'),
        h(
          'div',
          { class: 'server-item-text' },
          h('div', { class: 'server-name' }, s.name),
          h('div', { class: 'server-sub' }, `${s.username}@${s.host}`)
        ),
        h('span', { class: `status-dot ${view ? view.statusClass() : ''}` })
      )
    );
  }
}

function renderWelcome() {
  const hosts = state.sshHosts.filter((hh) => !state.servers.some((s) => s.host === hh.host && s.port === hh.port));
  $('#welcome').replaceChildren(
    h('div', { class: 'welcome-logo' }, icon('server')),
    h('h1', {}, 'Server Explorer'),
    h(
      'p',
      {},
      state.servers.length
        ? 'Select a server on the left to browse its folders, installed apps, services, Docker containers and more.'
        : 'Add your server to browse its folders and see which apps are installed, plus services, Docker, open ports and processes, without typing commands.'
    ),
    h('button', { class: 'btn primary large', onclick: () => openServerForm() }, icon('plus'), 'Add Server'),
    hosts.length
      ? h(
          'div',
          { class: 'welcome-hosts' },
          h('div', { class: 'welcome-hosts-title' }, 'Found in your ~/.ssh/config. Click to add:'),
          h(
            'div',
            { class: 'chips' },
            hosts.map((hh) => h('button', { class: 'btn', onclick: () => openServerForm(null, hh) }, icon('server'), hh.alias))
          )
        )
      : // Not null: this goes to the native replaceChildren, which renders a null child as the
        // literal text "null". h() filters nulls, but this call does not go through it.
        ''
  );
}

async function reloadServers() {
  state.servers = await api.listServers();
  for (const s of state.servers) state.views.get(s.id)?.setServer(s);
  renderSidebar();
  renderWelcome();
}

function selectServer(id) {
  const server = serverById(id);
  if (!server) return;
  state.selectedId = id;
  $('#welcome').hidden = true;
  let view = state.views.get(id);
  if (!view) {
    view = new ServerView(server);
    state.views.set(id, view);
  }
  for (const v of state.views.values()) v.el.hidden = v !== view;
  renderSidebar();
  if (view.status === 'disconnected' && !view.tried) view.connect();
  else if (view.tab === 'terminal') view.fitTerminal();
}

function showWelcome() {
  state.selectedId = null;
  for (const v of state.views.values()) v.el.hidden = true;
  $('#welcome').hidden = false;
  renderSidebar();
}

function removeView(id) {
  const view = state.views.get(id);
  if (!view) return;
  view.teardownTerminal();
  view.teardownAi();
  view.stopAutoRefresh();
  view.el.remove();
  state.views.delete(id);
  if (state.selectedId === id) showWelcome();
}

// ---------- Server view ----------

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'gauge' },
  { id: 'ai', label: 'AI', icon: 'sparkles' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'apps', label: 'Installed Apps', icon: 'package' },
  { id: 'websites', label: 'Websites', icon: 'globe' },
  { id: 'services', label: 'Services', icon: 'cog' },
  { id: 'docker', label: 'Docker', icon: 'layers' },
  { id: 'ports', label: 'Ports', icon: 'network' },
  { id: 'processes', label: 'Processes', icon: 'activity' },
  { id: 'users', label: 'Users', icon: 'users' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
];

// Which tab to refresh after a note is saved for that kind of item.
// What each database explorer calls things, and how its query box behaves.
const DB_ENGINES = {
  elasticsearch: { port: 9200, itemWord: 'index', itemsWord: 'indices', article: 'an', countWord: 'docs', pageSize: 20, runLabel: 'Search', schemaLabel: 'Mapping', queryHint: 'Search, e.g. level:error AND service:api', queryWithoutItem: false, health: true },
  mongodb: { port: 27017, itemWord: 'collection', itemsWord: 'collections', article: 'a', countWord: 'docs', pageSize: 20, runLabel: 'Find', schemaLabel: 'Fields', queryHint: 'Filter as JSON, e.g. {"status": "failed"}', queryWithoutItem: false },
  mssql: { port: 1433, itemWord: 'table', itemsWord: 'tables', article: 'a', countWord: 'rows', pageSize: 50, runLabel: 'Run', schemaLabel: 'Columns', queryHint: 'Browse the table, or type one SELECT to run (read-only)', queryWithoutItem: true },
};

const NOTE_TABS = { container: 'docker', image: 'docker', compose: 'docker', website: 'websites', service: 'services' };

const SOFTWARE_COLORS = ['#0a84ff', '#30b0c7', '#34c759', '#ff9f0a', '#ff375f', '#af52de', '#5e5ce6', '#a2845e'];

function softwareBadge(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || name).slice(0, 2)).toUpperCase();
  return h('div', { class: 'software-badge', style: { background: SOFTWARE_COLORS[hash % SOFTWARE_COLORS.length] } }, initials);
}

function softwareCard(sw) {
  return h(
    'div',
    { class: 'card software', title: sw.raw },
    softwareBadge(sw.name),
    h(
      'div',
      { style: { minWidth: '0' } },
      h('div', { class: 'software-name' }, sw.name),
      sw.version ? h('div', { class: 'software-version' }, sw.version) : null,
      h('div', { class: 'software-path', title: sw.path }, sw.path)
    )
  );
}

function serviceBadge(s) {
  if (s.sub === 'running') return h('span', { class: 'badge green' }, 'Running');
  if (s.active === 'failed' || s.sub === 'failed') return h('span', { class: 'badge red' }, 'Failed');
  if (s.sub === 'exited') return h('span', { class: 'badge' }, 'Ran once');
  if (s.active === 'activating' || s.sub === 'auto-restart') return h('span', { class: 'badge amber' }, cap(s.sub));
  return h('span', { class: 'badge' }, 'Stopped');
}

function simplifyPorts(ports) {
  if (!ports) return '';
  const set = new Set(
    ports
      .split(', ')
      .map((p) => p.replace(/^(0\.0\.0\.0|\[::\]):/, '').replace('->', ' → '))
      .filter(Boolean)
  );
  return [...set].join(', ');
}

class ServerView {
  constructor(server) {
    this.server = server;
    this.status = 'disconnected';
    this.error = '';
    this.tried = false;
    this.tab = 'overview';
    this.loaded = new Set();
    this.loadTokens = {};
    this.uiState = {};

    this.el = h('section', { class: 'server-view', hidden: true });
    this.titleEl = h('div', { class: 'sv-title' });
    this.subEl = h('div', { class: 'sv-sub' });
    this.pillEl = h('div', { class: 'status-pill' });
    this.actionsEl = h('div', { class: 'sv-actions' });
    this.tabButtons = {};
    this.panels = {};
    const tabs = h('nav', { class: 'tabs' });
    const body = h('div', { class: 'sv-body' });
    for (const t of TABS) {
      this.tabButtons[t.id] = h('button', { class: 'tab', onclick: () => this.showTab(t.id) }, icon(t.icon), t.label);
      tabs.append(this.tabButtons[t.id]);
      this.panels[t.id] = h('div', { class: 'panel', hidden: true });
      body.append(this.panels[t.id]);
    }
    this.overlayEl = h('div', { class: 'sv-overlay' });
    this.el.append(
      h('header', { class: 'sv-header drag' }, h('div', { class: 'sv-heading' }, this.titleEl, this.subEl), this.pillEl, this.actionsEl),
      tabs,
      body,
      this.overlayEl
    );
    $('#main').append(this.el);
    this.render();
  }

  ui(tab) {
    return (this.uiState[tab] ||= {});
  }

  statusClass() {
    return this.status === 'disconnected' && this.error ? 'failed' : this.status;
  }

  // Returns true when connection settings changed.
  setServer(server) {
    const changed = ['host', 'port', 'username', 'authType', 'keyPath'].some((k) => server[k] !== this.server[k]);
    this.server = server;
    this.render();
    return changed;
  }

  render() {
    const s = this.server;
    this.titleEl.textContent = s.name;
    this.subEl.textContent = `${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ''}`;
    const labels = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected' };
    this.pillEl.replaceChildren(h('span', { class: `status-dot ${this.statusClass()}` }), labels[this.status]);

    const editBtn = h('button', { class: 'icon-btn', title: 'Edit server', onclick: () => openServerForm(this.server) }, icon('edit'));
    if (this.status === 'connected') {
      this.actionsEl.replaceChildren(
        h('button', { class: 'icon-btn', title: 'Refresh (Ctrl+R)', onclick: () => this.refresh() }, icon('refresh')),
        editBtn,
        h('button', { class: 'btn', onclick: () => this.disconnect() }, icon('power'), 'Disconnect')
      );
    } else {
      this.actionsEl.replaceChildren(
        editBtn,
        h(
          'button',
          { class: 'btn primary', disabled: this.status === 'connecting', onclick: () => this.connect() },
          icon('power'),
          'Connect'
        )
      );
    }
    for (const t of TABS) this.tabButtons[t.id].classList.toggle('active', t.id === this.tab);
    this.renderOverlay();
    renderSidebar();
  }

  renderOverlay() {
    const s = this.server;
    if (this.status === 'connected') {
      this.overlayEl.hidden = true;
      return;
    }
    this.overlayEl.hidden = false;
    if (this.status === 'connecting') {
      this.overlayEl.replaceChildren(
        h(
          'div',
          { class: 'state-card' },
          h('div', { class: 'spinner' }),
          h('h2', {}, `Connecting to ${s.name}…`),
          h('p', {}, `${s.username}@${s.host}:${s.port}`)
        )
      );
      return;
    }
    this.overlayEl.replaceChildren(
      h(
        'div',
        { class: 'state-card' },
        h('div', { class: 'big-icon' }, icon(this.error ? 'alert' : 'server')),
        h('h2', {}, this.error ? `Not connected to ${s.name}` : s.name),
        this.error ? h('p', { class: 'error-text' }, this.error) : h('p', {}, `${s.username}@${s.host}:${s.port}`),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', onclick: () => openServerForm(s) }, icon('edit'), 'Edit Server'),
          h('button', { class: 'btn primary', onclick: () => this.connect() }, icon('power'), this.error ? 'Reconnect' : 'Connect')
        )
      )
    );
  }

  async connect() {
    if (this.status !== 'disconnected' || this.prompting) return;
    this.tried = true;
    let secret;
    let remember = false;
    if (this.server.authType === 'password' && !this.server.hasSecret) {
      this.prompting = true;
      const res = await promptDialog({
        title: 'Enter password',
        message: `Password for ${this.server.username}@${this.server.host}`,
        type: 'password',
        confirmText: 'Connect',
        checkboxLabel: 'Remember password (stored encrypted with Windows data protection)',
      });
      this.prompting = false;
      if (!res) return;
      secret = res.value;
      remember = res.checked && !!secret;
    }

    this.error = '';
    this.status = 'connecting';
    this.render();
    try {
      await api.connect(this.server.id, secret);
      this.status = 'connected';
      this.resetPanels();
      this.render();
      this.showTab(this.tab);
      if (remember) {
        await api.saveServer({ ...this.server, secret });
        await reloadServers();
      }
    } catch (err) {
      this.status = 'disconnected';
      this.error = err.message;
      this.render();
    }
  }

  async disconnect() {
    await api.disconnect(this.server.id).catch(() => {});
    this.onClosed('');
  }

  onClosed(message) {
    if (this.ai?.running) api.aiStop(this.ai.chatId);
    this.status = 'disconnected';
    this.error = message;
    this.teardownTerminal();
    this.stopAutoRefresh();
    this.render();
  }

  resetPanels() {
    this.loaded.clear();
    this.teardownTerminal();
    this.teardownAi();
    this.files = null;
    for (const panel of Object.values(this.panels)) {
      panel.classList.remove('flush');
      panel.replaceChildren();
    }
  }

  showTab(id) {
    this.tab = id;
    for (const t of TABS) {
      this.tabButtons[t.id].classList.toggle('active', t.id === id);
      this.panels[t.id].hidden = t.id !== id;
    }
    if (this.status !== 'connected') return;
    if (!this.loaded.has(id)) {
      this.loaded.add(id);
      this.loadTab(id);
    }
    if (id === 'terminal') {
      this.fitTerminal();
      this.term?.focus();
    }
    if (id === 'ai') setTimeout(() => this.aiEls?.input.focus(), 30);
  }

  refresh() {
    if (this.status !== 'connected') return;
    if (this.tab === 'files') {
      if (this.files?.path) this.navigate(this.files.path, false);
      return;
    }
    if (this.tab !== 'terminal') this.loadTab(this.tab);
  }

  loadTab(id) {
    const sid = this.server.id;
    switch (id) {
      case 'overview':
        return this.load(id, () => api.overview(sid), (p, d) => this.renderOverview(p, d));
      case 'apps':
        return this.load(id, () => api.apps(sid), (p, d) => this.renderApps(p, d), 'Scanning installed software…');
      case 'services':
        return this.load(id, () => this.withNotes(api.services(sid)), (p, d) => this.renderServices(p, d));
      case 'docker':
        return this.load(id, () => this.withNotes(api.docker(sid)), (p, d) => this.renderDocker(p, d));
      case 'ports':
        return this.load(id, () => this.withNotes(api.ports(sid)), (p, d) => this.renderPorts(p, d));
      case 'processes':
        return this.load(id, () => api.processes(sid), (p, d) => this.renderProcesses(p, d));
      case 'users':
        return this.load(id, () => api.users(sid), (p, d) => this.renderUsers(p, d));
      case 'websites':
        return this.load(id, () => this.withNotes(api.websites(sid)), (p, d) => this.renderWebsites(p, d));
      case 'ai':
        return this.initAi();
      case 'files':
        return this.initFiles();
      case 'terminal':
        return this.initTerminal();
    }
  }

  async load(tab, fetcher, render, loadingText, { quiet = false } = {}) {
    const panel = this.panels[tab];
    const token = (this.loadTokens[tab] || 0) + 1;
    this.loadTokens[tab] = token;
    if (!quiet) panel.replaceChildren(loadingEl(loadingText));
    try {
      const data = await fetcher();
      if (this.loadTokens[tab] !== token || this.status !== 'connected') return;
      const active = document.activeElement;
      const hadSearchFocus = panel.contains(active) && active.type === 'search';
      const scroll = panel.scrollTop;
      render(panel, data);
      panel.scrollTop = scroll;
      if (hadSearchFocus) {
        const input = panel.querySelector('input[type=search]');
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      }
    } catch (err) {
      if (this.loadTokens[tab] !== token || this.status !== 'connected') return;
      if (quiet) return;
      panel.replaceChildren(errorState(err.message, () => this.loadTab(tab)));
    }
  }

  // ----- Overview -----

  renderOverview(panel, d) {
    const m = d.memory;
    const memRatio = m ? ratio(m.used, m.total) : 0;
    const swapRatio = m && m.swapTotal ? ratio(m.swapUsed, m.swapTotal) : 0;
    const cards = [
      statCard('Operating system', d.os || '—', [d.kernel && `Kernel ${d.kernel}`, d.arch].filter(Boolean).join(' · ')),
      statCard('Uptime', (d.uptime || '—').replace(/^up\s+/, ''), d.bootTime ? `Running since ${d.bootTime}` : ''),
      statCard('CPU', d.cpus ? `${d.cpus} core${d.cpus > 1 ? 's' : ''}` : '—', d.cpuModel || ''),
      statCard(
        'Load average',
        d.load ? d.load.map((n) => n.toFixed(2)).join('  ·  ') : '—',
        d.load && d.cpus ? `${Math.round(ratio(d.load[0], d.cpus) * 100)}% of CPU capacity (1 / 5 / 15 min)` : '1 / 5 / 15 min',
        d.load && d.cpus ? meter(ratio(d.load[0], d.cpus)) : null
      ),
      statCard(
        'Memory',
        m ? `${fmtBytes(m.used)} of ${fmtBytes(m.total)}` : '—',
        m ? `${Math.round(memRatio * 100)}% used` : '',
        m ? meter(memRatio) : null
      ),
      statCard(
        'Swap',
        m && m.swapTotal ? `${fmtBytes(m.swapUsed)} of ${fmtBytes(m.swapTotal)}` : 'None',
        m && m.swapTotal ? `${Math.round(swapRatio * 100)}% used` : 'No swap configured',
        m && m.swapTotal ? meter(swapRatio) : null
      ),
      statCard('Hostname', d.hostname || '—', d.ips.length ? `IP ${d.ips.join(', ')}` : this.server.host),
      statCard(
        'Processes',
        String(d.processCount || '—'),
        `Signed in as ${d.user}${d.loggedInUsers ? ` · ${d.loggedInUsers} login session${d.loggedInUsers > 1 ? 's' : ''}` : ''}`
      ),
    ];

    const diskRatio = (r) => ratio(r.used, r.used + r.available);
    const diskCols = [
      { key: 'mount', label: 'Mounted at', class: 'mono' },
      { key: 'filesystem', label: 'Device', class: 'mono muted' },
      { key: 'total', label: 'Size', num: true, render: (r) => fmtBytes(r.total) },
      { key: 'used', label: 'Used', num: true, render: (r) => fmtBytes(r.used) },
      { key: 'available', label: 'Free', num: true, render: (r) => fmtBytes(r.available) },
      {
        key: 'usage',
        label: 'Usage',
        width: '220px',
        render: (r) =>
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('div', { style: { flex: '1' } }, meter(diskRatio(r))),
            h('span', { class: 'mono', style: { width: '40px', textAlign: 'right' } }, `${Math.round(diskRatio(r) * 100)}%`)
          ),
      },
    ];

    panel.replaceChildren(
      section('System', null, null, h('div', { class: 'stat-grid' }, cards)),
      section('Disks', h('span', { class: 'count' }, d.disks.length), null, dataTable({ columns: diskCols, rows: d.disks, empty: 'No disk information' }))
    );
  }

  // ----- Installed apps & installing software -----

  renderApps(panel, d) {
    const ui = this.ui('apps');
    ui.sort ||= { key: 'name', dir: 1 };
    ui.search ||= '';
    const installedNames = new Set(d.packages.list.map((p) => p.name));
    const canInstall = d.access.mode !== 'none';

    const searchEl = h(
      'div',
      { class: 'app-search' },
      icon('search'),
      h('input', {
        class: 'input',
        type: 'search',
        placeholder: 'Search apps and packages, e.g. docker, redis, htop',
        value: ui.search,
        spellcheck: false,
        oninput: (e) => {
          ui.search = e.target.value;
          update();
        },
      })
    );
    let accessNote = null;
    if (d.access.mode === 'none') {
      accessNote = notice("This login can't install software: it isn't root and sudo isn't available. Connect as root or a user with sudo rights to install apps.");
    } else if (d.access.mode === 'password') {
      accessNote = h('div', { class: 'app-search-hint' }, 'Installing uses sudo. If your login password is needed and not saved, you will be asked for it.');
    }

    // Catalog of popular apps
    const catalogGrid = h('div', { class: 'app-grid' });
    const catalogSection = section('Apps', h('span', { class: 'hint' }, 'Popular server software, installed the recommended way'), null, catalogGrid);

    // Live search of the server's package manager
    const availableHint = h('span', { class: 'hint' });
    const availableHost = h('div');
    const availableSection = h(
      'div',
      { class: 'section', hidden: true },
      h('div', { class: 'section-head' }, h('h3', {}, 'Packages you can install'), availableHint),
      availableHost
    );

    // Detected software that isn't already shown in the catalog
    const catalogBins = new Set(d.catalog.map((c) => c.bin).concat(['httpd', 'mysqld', 'mariadbd']));
    const otherDetected = d.detected.filter((x) => !catalogBins.has(x.bin));
    const detectedGrid = h('div', { class: 'software-grid' });
    const detectedSection = otherDetected.length ? section('Other detected software', null, null, detectedGrid) : null;

    // Installed packages
    const pk = d.packages;
    const count = h('span', { class: 'count' }, pk.list.length);
    const cols = [
      { key: 'name', label: 'Package', class: 'mono nowrap' },
      { key: 'version', label: 'Version', class: 'mono muted nowrap' },
    ];
    if (pk.list.some((p) => p.size)) cols.push({ key: 'size', label: 'Size', num: true, render: (p) => (p.size ? fmtBytes(p.size) : '') });
    if (pk.list.some((p) => p.description)) cols.push({ key: 'description', label: 'Description', class: 'truncate muted', title: (p) => p.description });
    const table = tableSection({
      ui,
      columns: cols,
      rows: pk.list,
      searchKeys: ['name', 'description'],
      placeholder: '',
      empty: 'No installed packages',
      onCount: (n) => (count.textContent = n),
    });
    const packagesSection = pk.manager
      ? section('Installed packages', [count, h('span', { class: 'hint' }, `via ${pk.manager}`)], null, table.host)
      : section('Installed packages', null, null, h('div', { class: 'card empty' }, 'No supported package manager found (apt, rpm, apk, pacman).'));

    const drawCatalog = () => {
      const q = ui.search.trim().toLowerCase();
      const items = d.catalog.filter((c) => !q || [c.name, c.id, c.category, c.description].some((v) => v.toLowerCase().includes(q)));
      catalogGrid.replaceChildren(...items.map((c) => this.catalogCard(c, canInstall)));
      catalogSection.hidden = !items.length;
    };
    const drawDetected = () => {
      if (!detectedSection) return;
      const q = ui.search.trim().toLowerCase();
      const items = otherDetected.filter((x) => !q || x.name.toLowerCase().includes(q));
      detectedGrid.replaceChildren(...items.map(softwareCard));
      detectedSection.hidden = !items.length;
    };

    let searchTimer = null;
    const searchAvailable = () => {
      clearTimeout(searchTimer);
      const q = ui.search.trim();
      const token = (this.packageSearchToken = (this.packageSearchToken || 0) + 1);
      if (q.length < 2) {
        availableSection.hidden = true;
        return;
      }
      searchTimer = setTimeout(async () => {
        availableSection.hidden = false;
        availableHint.textContent = 'Searching…';
        availableHost.replaceChildren();
        try {
          const res = await api.searchPackages(this.server.id, q);
          if (token !== this.packageSearchToken || !panel.contains(availableHost)) return;
          availableHint.textContent = res.manager ? `from ${res.manager}` : '';
          if (res.stale) {
            availableHost.replaceChildren(
              h(
                'div',
                { class: 'card empty' },
                h('p', { style: { margin: '0 0 12px' } }, "The server's package list hasn't been downloaded yet, so search can't find anything."),
                h('button', { class: 'btn', disabled: !canInstall, onclick: () => this.refreshPackageLists() }, icon('refresh'), 'Update Package List')
              )
            );
            return;
          }
          if (!res.results.length) {
            availableHost.replaceChildren(h('div', { class: 'card empty' }, `No packages found for "${q}".`));
            return;
          }
          const resultCols = [
            { key: 'name', label: 'Package', class: 'mono nowrap' },
            { key: 'description', label: 'Description', class: 'truncate muted', title: (r) => r.description },
            {
              key: 'action',
              label: '',
              width: '120px',
              render: (r) =>
                installedNames.has(r.name)
                  ? h('span', { class: 'badge green' }, icon('check'), 'Installed')
                  : h('button', { class: 'btn small', disabled: !canInstall, onclick: () => this.installPackage(r.name) }, icon('download'), 'Install'),
            },
          ];
          availableHost.replaceChildren(dataTable({ columns: resultCols, rows: res.results }));
        } catch (err) {
          if (token === this.packageSearchToken) availableHost.replaceChildren(notice(err.message, 'error'));
        }
      }, 450);
    };

    const update = () => {
      drawCatalog();
      drawDetected();
      table.draw();
      searchAvailable();
    };
    update();

    const parts = [searchEl, accessNote, catalogSection, availableSection, detectedSection];
    if (d.pm2.length) {
      const pm2Cols = [
        { key: 'status', label: 'Status', render: (p) => h('span', { class: `badge ${p.status === 'online' ? 'green' : p.status === 'errored' ? 'red' : ''}` }, cap(p.status)) },
        { key: 'name', label: 'Name', class: 'mono nowrap' },
        { key: 'cpu', label: 'CPU %', num: true },
        { key: 'memory', label: 'Memory', num: true, render: (p) => fmtBytes(p.memory) },
        { key: 'restarts', label: 'Restarts', num: true },
        { key: 'cwd', label: 'Folder', class: 'truncate mono muted', title: (p) => p.script },
      ];
      parts.push(section('PM2 apps', h('span', { class: 'count' }, d.pm2.length), null, dataTable({ columns: pm2Cols, rows: d.pm2 })));
    }
    parts.push(packagesSection);
    if (d.snaps.length) {
      const snapCols = [
        { key: 'name', label: 'Snap', class: 'mono nowrap' },
        { key: 'version', label: 'Version', class: 'mono muted' },
        { key: 'tracking', label: 'Channel', class: 'muted' },
        { key: 'publisher', label: 'Publisher', class: 'muted' },
      ];
      parts.push(section('Snap packages', h('span', { class: 'count' }, d.snaps.length), null, dataTable({ columns: snapCols, rows: d.snaps })));
    }
    panel.replaceChildren(...parts.filter(Boolean));
  }

  catalogCard(item, canInstall) {
    const actions = item.installed
      ? [
          h('span', { class: 'badge green' }, icon('check'), item.version ? `Installed · ${item.version}` : 'Installed'),
          item.removable
            ? h('button', { class: 'btn small', disabled: !canInstall, onclick: () => this.uninstallApp(item) }, 'Uninstall')
            : null,
        ]
      : [
          h('span', { class: 'badge' }, 'Not installed'),
          h('button', { class: 'btn small primary', disabled: !canInstall, onclick: () => this.installApp(item) }, icon('download'), 'Install'),
        ];
    return h(
      'div',
      { class: 'card app-card' },
      h(
        'div',
        { class: 'app-card-top' },
        softwareBadge(item.name),
        h('div', { style: { minWidth: '0' } }, h('div', { class: 'software-name' }, item.name), h('div', { class: 'stat-detail' }, item.category))
      ),
      h('div', { class: 'app-desc' }, item.description),
      h('div', { class: 'app-actions' }, actions)
    );
  }

  async installApp(item) {
    const ok = await confirmDialog({
      title: `Install ${item.name}?`,
      message: `${item.name} will be installed on ${this.server.name}. ${item.description} This can take a few minutes.`,
      confirmText: 'Install',
    });
    if (ok) this.runJob({ kind: 'catalog', id: item.id, action: 'install' }, { title: `Installing ${item.name}`, doneText: `${item.name} is installed`, note: item.note });
  }

  async uninstallApp(item) {
    const ok = await confirmDialog({
      title: `Uninstall ${item.name}?`,
      message: `${item.name} will be removed from ${this.server.name}. ${item.keepsData}`,
      confirmText: 'Uninstall',
      danger: true,
    });
    if (ok) this.runJob({ kind: 'catalog', id: item.id, action: 'remove' }, { title: `Uninstalling ${item.name}`, doneText: `${item.name} was uninstalled` });
  }

  async installPackage(name) {
    const ok = await confirmDialog({
      title: `Install ${name}?`,
      message: `The package "${name}" will be installed on ${this.server.name} with the system package manager.`,
      confirmText: 'Install',
    });
    if (ok) this.runJob({ kind: 'package', name }, { title: `Installing ${name}`, doneText: `${name} is installed` });
  }

  refreshPackageLists() {
    this.runJob({ kind: 'refresh' }, { title: 'Updating package list', doneText: 'Package list updated' });
  }

  // ----- AI assistant -----

  async initAi() {
    const panel = this.panels.ai;
    panel.classList.add('flush');
    this.teardownAi();
    const ai = (this.ai = { chatId: null, folders: [], mode: 'readonly', lockedMode: null, autoApprove: false, running: false, textEl: null, activities: new Map(), requests: new Map() });
    const els = (this.aiEls = {
      toolbar: h('div', { class: 'ai-toolbar' }),
      notice: h('div', { class: 'ai-notice', hidden: true }),
      messages: h('div', { class: 'ai-messages' }),
      inner: h('div', { class: 'ai-inner' }),
      typing: h('div', { class: 'ai-typing', hidden: true }, h('span'), h('span'), h('span')),
      input: h('textarea', { class: 'ai-input', rows: '1', placeholder: 'Ask anything about this server… (Enter to send, Shift+Enter for a new line)' }),
      sendBtn: h('button', { class: 'btn primary ai-send', onclick: () => this.aiSendOrStop() }),
    });
    els.messages.append(els.inner);
    els.inner.append(els.typing);
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!ai.running) this.aiSendOrStop();
      }
    });
    els.input.addEventListener('input', () => this.aiAutosize());
    panel.replaceChildren(els.toolbar, els.notice, els.messages, h('div', { class: 'ai-composer' }, h('div', { class: 'ai-composer-inner' }, els.input, els.sendBtn)));
    this.updateAiComposer();

    try {
      const [settings, chatId] = await Promise.all([api.aiSettings(), api.aiCreateChat(this.server.id)]);
      state.aiSettings = settings;
      ai.chatId = chatId;
      const modeInfo = await api.aiGetModeInfo(chatId);
      ai.mode = modeInfo.mode;
      ai.lockedMode = modeInfo.lockedMode;
    } catch (err) {
      panel.replaceChildren(
        errorState(err.message, () => {
          this.loaded.delete('ai');
          this.showTab('ai');
        })
      );
      return;
    }
    if (this.ai !== ai) {
      api.aiDisposeChat(ai.chatId);
      return;
    }
    aiChats.set(ai.chatId, this);
    this.renderAiToolbar();
    this.renderAiEmpty();
    this.checkAiProvider();
  }

  teardownAi() {
    if (!this.ai) return;
    if (this.ai.chatId) {
      aiChats.delete(this.ai.chatId);
      api.aiDisposeChat(this.ai.chatId).catch(() => {});
    }
    this.ai = null;
    this.aiEls = null;
  }

  async saveAiSettings(patch) {
    state.aiSettings = await api.aiSaveSettings(patch);
    this.renderAiToolbar();
    if (patch.provider) this.checkAiProvider();
  }

  async setAiMode(mode) {
    const ai = this.ai;
    if (!ai || ai.mode === mode) return;
    try {
      ai.mode = await api.aiSetMode(ai.chatId, mode);
      // setMode() drops any blanket approval in the main process; keep the UI in step.
      ai.autoApprove = false;
      this.setAiNotice(null);
      this.renderAiToolbar();
    } catch (err) {
      this.setAiNotice(err.message);
    }
  }

  async checkAiProvider() {
    if (state.aiSettings.provider !== 'claude') return;
    const info = await api.aiDetect().catch((err) => ({ available: false, error: err.message }));
    if (!this.ai || state.aiSettings.provider !== 'claude') return;
    if (info.available) {
      this.setAiNotice(null);
      return;
    }
    console.error('Claude CLI detection failed:', info);
    const retry = { label: 'Retry', onclick: () => this.checkAiProvider() };
    const setPath = { label: 'Set path manually', onclick: () => this.openClaudeCliSettings() };
    if (info.overrideInvalid) {
      this.setAiNotice(`The Claude CLI path you set (${info.path}) doesn't look valid. Check it in Claude CLI settings.`, [setPath, retry]);
    } else {
      this.setAiNotice(
        `The Claude CLI wasn't found (checked ${info.checked ?? '?'} PATH ${info.checked === 1 ? 'directory' : 'directories'}). Install it with \`npm install -g @anthropic-ai/claude-code\` and log in once by running \`claude\`, set its path manually, or switch to 9router.`,
        [setPath, retry]
      );
    }
  }

  setAiNotice(text, actions) {
    const el = this.aiEls?.notice;
    if (!el) return;
    el.hidden = !text;
    if (!text) return;
    const buttons = typeof actions === 'function' ? [{ label: 'Retry', onclick: actions }] : actions || [];
    el.replaceChildren(
      icon('alert'),
      h('div', { style: { flex: '1' } }, text),
      ...buttons.map((a) => h('button', { class: 'btn small', onclick: a.onclick }, a.label))
    );
  }

  renderAiToolbar() {
    const s = state.aiSettings;
    const ai = this.ai;
    if (!s || !ai) return;
    const provider = h(
      'div',
      { class: 'segmented' },
      ...[
        ['claude', 'Claude CLI'],
        ['router', '9router'],
      ].map(([id, label]) => h('button', { class: s.provider === id ? 'active' : '', onclick: () => this.saveAiSettings({ provider: id }) }, label))
    );
    let model;
    if (s.provider === 'claude') {
      const select = h(
        'select',
        { class: 'input', title: 'Claude model', onchange: (e) => this.saveAiSettings({ claudeModel: e.target.value }) },
        ...[
          ['default', 'Default model'],
          ['opus', 'Opus (smartest)'],
          ['sonnet', 'Sonnet'],
          ['haiku', 'Haiku (fastest)'],
        ].map(([value, label]) => h('option', { value }, label))
      );
      select.value = s.claudeModel;
      model = h('div', { class: 'ai-row' }, select, h('button', { class: 'icon-btn', title: 'Claude CLI settings', onclick: () => this.openClaudeCliSettings() }, icon('cog')));
    } else {
      const select = h('select', { class: 'input', title: '9router model', onchange: (e) => this.saveAiSettings({ routerModel: e.target.value }) }, h('option', { value: '' }, 'Loading models…'));
      this.loadRouterModels(select);
      model = h('div', { class: 'ai-row' }, select, h('button', { class: 'icon-btn', title: '9router settings', onclick: () => this.openRouterSettings() }, icon('cog')));
    }
    const folders = h(
      'div',
      { class: 'ai-folders', title: 'Folders on your PC the AI can read and upload from' },
      icon('laptop'),
      ai.folders.length
        ? ai.folders.map((f) =>
            h(
              'span',
              { class: 'chip', title: f },
              f.split('/').pop() || f,
              h('button', { class: 'chip-x', title: 'Stop sharing', onclick: () => this.setAiFolders(ai.folders.filter((x) => x !== f)) }, icon('x'))
            )
          )
        : h('span', {}, 'No local folders shared'),
      h('button', { class: 'btn small', onclick: () => this.attachAiFolder() }, icon('plus'), 'Attach Folder')
    );
    const locked = Boolean(ai.lockedMode);
    const security = h(
      'div',
      {
        class: 'segmented ai-mode',
        title: locked
          ? `The security mode is locked to ${AI_MODE_LABELS[ai.lockedMode]} in settings.json.`
          : 'What the assistant is allowed to do on this server',
      },
      ...AI_MODES.map(([id, label]) =>
        h(
          'button',
          {
            class: `${ai.mode === id ? 'active' : ''} mode-${id}`,
            disabled: locked || null,
            onclick: () => this.setAiMode(id),
          },
          label
        )
      )
    );
    const readonly = ai.mode === 'readonly';
    const auto = h(
      'label',
      {
        class: `checkbox ai-auto ${ai.autoApprove ? 'on' : ''} ${readonly ? 'disabled' : ''}`,
        title: readonly
          ? 'Read-only mode makes no changes, so there is nothing to approve'
          : 'When on, the AI runs ordinary commands and writes without asking. Destructive actions, credential files and system files always ask.',
      },
      h('input', {
        type: 'checkbox',
        checked: ai.autoApprove,
        disabled: readonly || null,
        onchange: (e) => {
          if (
            e.target.checked &&
            !confirm(
              'Let the assistant run commands and write files without asking each time?\n\nDestructive actions, credential files and system files will still always ask you.'
            )
          ) {
            e.target.checked = false;
            return;
          }
          ai.autoApprove = e.target.checked;
          api.aiSetAutoApprove(ai.chatId, ai.autoApprove);
          this.renderAiToolbar();
        },
      }),
      'Auto-approve'
    );
    const auditLog = h('button', { class: 'icon-btn', title: 'Show what the assistant has done (activity log)', onclick: () => api.aiOpenAuditLog() }, icon('activity'));
    const newChat = h('button', { class: 'btn small', onclick: () => this.newAiChat() }, 'New Chat');
    this.aiEls.toolbar.replaceChildren(provider, model, h('div', { class: 'spacer' }), security, folders, auto, auditLog, newChat);
  }

  async loadRouterModels(select) {
    try {
      const models = await api.aiModels();
      const saved = state.aiSettings.routerModel;
      select.replaceChildren(h('option', { value: '' }, models.length ? 'Choose a model' : 'No models available'), ...models.map((m) => h('option', { value: m }, m)));
      if (saved && !models.includes(saved)) select.append(h('option', { value: saved }, saved));
      select.value = saved || '';
      this.setAiNotice(saved ? null : 'Choose which 9router model the assistant should use.');
    } catch (err) {
      select.replaceChildren(h('option', { value: '' }, 'Not connected'));
      this.setAiNotice(`${err.message} Start it by running \`9router\` in PowerShell or Windows Terminal, or check the address and key in 9router settings.`, () => this.renderAiToolbar());
    }
  }

  openRouterSettings() {
    const s = state.aiSettings;
    const url = h('input', { class: 'input', value: s.routerUrl, spellcheck: false });
    const key = h('input', { class: 'input', type: 'password', placeholder: s.hasRouterKey ? 'Saved. Leave blank to keep it' : 'Copy it from the 9router dashboard' });
    const result = h('div', { class: 'help' });
    const save = async () => {
      const patch = { routerUrl: url.value.trim() };
      if (key.value) patch.routerKey = key.value;
      state.aiSettings = await api.aiSaveSettings(patch);
      key.value = '';
      if (state.aiSettings.hasRouterKey) key.placeholder = 'Saved. Leave blank to keep it';
    };
    const close = openModal({
      title: '9router settings',
      body: h(
        'div',
        { class: 'form-stack' },
        h('p', {}, '9router runs on your PC and connects to many AI models. Start it by running `9router` in PowerShell or Windows Terminal. Its dashboard shows the API key.'),
        h('div', { class: 'field' }, h('label', {}, 'API address'), url),
        h('div', { class: 'field' }, h('label', {}, 'API key'), key, result)
      ),
      footer: [
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              await save();
              result.textContent = 'Testing…';
              try {
                const models = await api.aiModels();
                result.textContent = `Connected. ${models.length} models available.`;
              } catch (err) {
                result.textContent = err.message;
              }
            },
          },
          'Test Connection'
        ),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              await save();
              close();
              this.renderAiToolbar();
            },
          },
          'Save'
        ),
      ],
    });
  }

  openClaudeCliSettings() {
    const s = state.aiSettings;
    const pathInput = h('input', { class: 'input', value: s.claudePath || '', placeholder: 'Leave blank to auto-detect', spellcheck: false });
    const result = h('div', { class: 'help' });
    const save = async () => {
      state.aiSettings = await api.aiSaveSettings({ claudePath: pathInput.value.trim() });
    };
    const close = openModal({
      title: 'Claude CLI settings',
      body: h(
        'div',
        { class: 'form-stack' },
        h('p', {}, "By default the Claude CLI is detected automatically. If it can't be found, set the full path to its executable here."),
        h(
          'div',
          { class: 'field' },
          h('label', {}, 'Claude CLI path'),
          h(
            'div',
            { class: 'field-row' },
            pathInput,
            h('button', { class: 'btn', onclick: async () => {
              const picked = await api.pickClaudeBinary();
              if (picked) pathInput.value = picked;
            } }, 'Choose…')
          ),
          h('button', { class: 'btn small', onclick: () => { pathInput.value = ''; result.textContent = ''; } }, 'Detect automatically'),
          result
        )
      ),
      footer: [
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              await save();
              result.textContent = 'Testing…';
              const info = await api.aiDetect().catch((err) => ({ available: false, error: err.message }));
              result.textContent = info.available
                ? `Found: ${info.path} (${info.version})`
                : info.overrideInvalid
                  ? "That path isn't a valid executable."
                  : info.error || 'The Claude CLI was not found.';
            },
          },
          'Test'
        ),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              await save();
              close();
              this.renderAiToolbar();
              this.checkAiProvider();
            },
          },
          'Save'
        ),
      ],
    });
  }

  async attachAiFolder() {
    const folder = await api.aiPickFolder();
    if (folder && this.ai && !this.ai.folders.includes(folder)) await this.setAiFolders([...this.ai.folders, folder]);
  }

  async setAiFolders(folders) {
    try {
      this.ai.folders = await api.aiSetFolders(this.ai.chatId, folders);
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
    this.renderAiToolbar();
  }

  async newAiChat() {
    const ai = this.ai;
    if (!ai?.chatId) return;
    await api.aiResetChat(ai.chatId);
    ai.autoApprove = false;
    ai.textEl = null;
    ai.activities.clear();
    ai.requests.clear();
    this.aiEls.inner.replaceChildren(this.aiEls.typing);
    this.renderAiToolbar();
    this.renderAiEmpty();
  }

  renderAiEmpty() {
    const els = this.aiEls;
    if (!els || els.inner.children.length > 1) return;
    const examples = [
      'What is running on this server, and is anything using too much memory or disk?',
      'Install Docker and make sure it starts automatically after a reboot.',
      'Replicate the Docker setup from my attached folder on this server.',
      "My website isn't loading. Can you find out why?",
    ];
    els.inner.insertBefore(
      h(
        'div',
        { class: 'ai-empty' },
        h('div', { class: 'welcome-logo ai-logo' }, icon('sparkles')),
        h('h2', {}, `Ask AI to help with ${this.server.name}`),
        h(
          'p',
          {},
          "It can look around the server, run commands and set things up. You approve every command, file change and upload before it happens. Attach a folder from your PC if it should use your local files."
        ),
        h(
          'div',
          { class: 'ai-examples' },
          examples.map((text) =>
            h(
              'button',
              {
                class: 'ai-example',
                onclick: () => {
                  els.input.value = text;
                  this.aiAutosize();
                  els.input.focus();
                },
              },
              text
            )
          )
        )
      ),
      els.typing
    );
  }

  aiAutosize() {
    const input = this.aiEls.input;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  updateAiComposer() {
    const btn = this.aiEls?.sendBtn;
    if (!btn) return;
    const running = this.ai?.running;
    btn.className = `btn ai-send ${running ? 'danger' : 'primary'}`;
    btn.replaceChildren(icon(running ? 'square' : 'send'), running ? 'Stop' : 'Send');
  }

  aiSendOrStop() {
    const ai = this.ai;
    if (!ai?.chatId) return;
    if (ai.running) {
      api.aiStop(ai.chatId);
      return;
    }
    const text = this.aiEls.input.value.trim();
    if (!text) return;
    if (this.status !== 'connected') {
      toast('Connect to the server first.', { type: 'error' });
      return;
    }
    this.aiEls.inner.querySelector('.ai-empty')?.remove();
    this.addAiElement(h('div', { class: 'ai-msg user' }, text), true);
    this.aiEls.input.value = '';
    this.aiAutosize();
    ai.running = true;
    this.aiEls.typing.hidden = false;
    this.updateAiComposer();
    api.aiSend(ai.chatId, text).catch((err) => this.onAiEvent({ type: 'turn-end', error: err.message }));
  }

  addAiElement(el, forceScroll = false) {
    const box = this.aiEls.messages;
    const stick = forceScroll || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    this.aiEls.inner.querySelector('.ai-empty')?.remove();
    this.aiEls.inner.insertBefore(el, this.aiEls.typing);
    if (stick) box.scrollTop = box.scrollHeight;
  }

  onAiEvent(event) {
    const ai = this.ai;
    if (!ai || !this.aiEls) return;
    switch (event.type) {
      case 'turn-start':
        ai.running = true;
        ai.textEl = null;
        this.aiEls.typing.hidden = false;
        this.updateAiComposer();
        break;
      case 'text-start':
        ai.textEl = null;
        break;
      case 'text':
        this.appendAiText(event.delta);
        break;
      case 'activity':
        this.addAiActivity(event.activity);
        break;
      case 'activity-update':
        this.updateAiActivity(event.id, event.patch);
        break;
      case 'activity-output':
        this.appendAiActivityOutput(event.id, event.chunk);
        break;
      case 'request':
        this.addAiRequest(event.request);
        break;
      case 'request-done':
        this.finishAiRequest(event.id, 'Cancelled');
        break;
      case 'auto-approve':
        ai.autoApprove = event.value;
        this.renderAiToolbar();
        break;
      case 'notice':
        this.addAiElement(h('div', { class: 'ai-note' }, event.text));
        break;
      case 'turn-end':
        ai.running = false;
        ai.textEl = null;
        this.aiEls.typing.hidden = true;
        this.updateAiComposer();
        if (event.error) this.addAiElement(h('div', { class: 'notice error' }, icon('alert'), h('div', {}, event.error)));
        else if (event.stopped) this.addAiElement(h('div', { class: 'ai-note' }, 'Stopped.'));
        break;
    }
  }

  appendAiText(delta) {
    const ai = this.ai;
    if (!ai.textEl) {
      ai.textEl = h('div', { class: 'ai-msg assistant' });
      ai.textEl.raw = '';
      this.addAiElement(ai.textEl);
    }
    const el = ai.textEl;
    el.raw += delta;
    if (el.renderTimer) return;
    el.renderTimer = setTimeout(() => {
      el.renderTimer = null;
      if (!this.aiEls) return;
      const box = this.aiEls.messages;
      const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      el.replaceChildren(renderMarkdown(el.raw));
      if (stick) box.scrollTop = box.scrollHeight;
    }, 40);
  }

  addAiActivity(activity) {
    const icons = {
      run_server_command: 'terminal',
      read_server_file: 'file',
      list_server_dir: 'folder',
      write_server_file: 'edit',
      upload_local_path: 'upload',
      list_local_dir: 'laptop',
      read_local_file: 'laptop',
    };
    const status = h('span', { class: 'badge' });
    const output = h('pre', { class: 'ai-output', hidden: true });
    const toggle = h(
      'button',
      {
        class: 'link-btn',
        hidden: true,
        onclick: () => {
          output.hidden = !output.hidden;
          toggle.textContent = output.hidden ? 'Show output' : 'Hide output';
        },
      },
      'Show output'
    );
    const el = h(
      'div',
      { class: 'ai-activity' },
      h('div', { class: 'ai-activity-head' }, icon(icons[activity.tool] || 'activity'), h('span', { class: 'ai-activity-title' }, activity.title), toggle, status),
      activity.detail ? h('div', { class: 'ai-activity-detail' }, activity.detail) : null,
      output
    );
    this.ai.activities.set(activity.id, { el, status, output, toggle, tool: activity.tool });
    this.ai.textEl = null;
    this.setAiActivityStatus(activity.id, activity.status);
    this.addAiElement(el);
  }

  setAiActivityStatus(id, status, code) {
    const rec = this.ai.activities.get(id);
    if (!rec) return;
    const [cls, label] = {
      pending: ['', 'Working…'],
      running: ['blue', 'Running…'],
      done: ['green', 'Done'],
      error: ['red', code != null ? `Failed (exit ${code})` : 'Failed'],
      denied: ['amber', 'Skipped'],
    }[status] || ['', status];
    rec.status.className = `badge ${cls}`;
    rec.status.textContent = label;
  }

  updateAiActivity(id, patch) {
    if (patch.status) this.setAiActivityStatus(id, patch.status, patch.code);
    if (patch.output) this.appendAiActivityOutput(id, `${patch.output}\n`);
  }

  appendAiActivityOutput(id, chunk) {
    const rec = this.ai.activities.get(id);
    if (!rec) return;
    const out = rec.output;
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
    let text = out.textContent + chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r+\n/g, '\n').replace(/\r/g, '\n');
    if (text.length > 100000) text = text.slice(-100000);
    out.textContent = text;
    rec.toggle.hidden = false;
    if (!out.hidden && atBottom) out.scrollTop = out.scrollHeight;
  }

  addAiRequest(request) {
    let el;
    if (request.type === 'password') {
      const input = h('input', { class: 'input', type: 'password', placeholder: 'Password' });
      const submit = () => {
        const password = input.value;
        input.value = '';
        this.respondAi(request.id, { password }, 'Password sent');
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
      el = h(
        'div',
        { class: 'ai-approval' },
        h(
          'div',
          { class: 'ai-approval-title' },
          icon('key'),
          request.retry ? 'That password was not accepted. Try again:' : `Enter the sudo password for ${this.server.username} to continue:`
        ),
        h(
          'div',
          { class: 'ai-row' },
          input,
          h('button', { class: 'btn primary', onclick: submit }, 'Continue'),
          h('button', { class: 'btn', onclick: () => this.respondAi(request.id, {}, 'Cancelled') }, 'Cancel')
        )
      );
      setTimeout(() => input.focus(), 30);
    } else {
      const allowLabel = { command: 'Run', upload: 'Upload', write: 'Write File', read: 'Allow Read' }[request.kind] || 'Allow';
      const warnings = request.warnings || [];
      el = h(
        'div',
        { class: `ai-approval ${request.risk === 'destructive' ? 'risky' : ''}` },
        h(
          'div',
          { class: 'ai-approval-title' },
          icon('shield'),
          request.title,
          request.risk ? h('span', { class: `risk-badge risk-${request.risk}` }, request.risk === 'destructive' ? 'Destructive' : cap(request.risk)) : null
        ),
        request.explanation ? h('div', { class: 'ai-approval-why' }, request.explanation) : null,
        warnings.length ? h('div', { class: 'ai-approval-warn' }, icon('alert'), warnings.join(' ')) : null,
        h('pre', { class: 'ai-code' }, request.code),
        h(
          'div',
          { class: 'ai-row' },
          h('button', { class: 'btn primary', onclick: () => this.respondAi(request.id, { decision: 'allow' }, 'Allowed') }, allowLabel),
          h('button', { class: 'btn', onclick: () => this.respondAi(request.id, { decision: 'deny' }, 'Skipped') }, 'Skip'),
          h('div', { class: 'spacer' }),
          // Blanket approval never covers this class, so offering the button would be a lie.
          request.forceAsk
            ? h('span', { class: 'ai-approval-note' }, 'Always asks')
            : h(
                'button',
                { class: 'btn small', title: 'Stop asking for the rest of this chat', onclick: () => this.respondAi(request.id, { decision: 'allowAll' }, 'Allowed, and auto-approve is on') },
                'Allow All in This Chat'
              )
        )
      );
    }
    this.ai.requests.set(request.id, el);
    this.addAiElement(el);
  }

  respondAi(requestId, response, label) {
    api.aiRespond(this.ai.chatId, requestId, response);
    this.finishAiRequest(requestId, label);
  }

  finishAiRequest(requestId, label) {
    const el = this.ai?.requests.get(requestId);
    if (!el) return;
    this.ai.requests.delete(requestId);
    el.classList.add('done');
    for (const control of el.querySelectorAll('button, input')) control.disabled = true;
    el.append(h('div', { class: 'ai-approval-result' }, label));
  }

  // ----- Jobs (anything that changes the server) -----

  // Runs a job in a log window, asking for the sudo password when needed. Returns true on success.
  async runJob(spec, { title, doneText, note, busyMessage, doneMessage, after = () => this.afterSoftwareChange() }) {
    let password;
    for (;;) {
      const result = await this.showJob(spec, { title, password, busyMessage, doneMessage });
      if (result.needPassword) {
        password = await this.askSudoPassword(password);
        if (!password) return false;
        continue;
      }
      if (result.ok) {
        if (doneText) toast(doneText, { type: 'success' });
        if (note) toast(note);
        if (after) after();
      }
      return result.ok;
    }
  }

  // Runs a short job without a log window: a busy toast, then a success or error toast.
  async runQuickJob(spec, { busyText, doneText }) {
    let password;
    for (;;) {
      const busy = toast(busyText, { busy: true });
      const result = await this.execJob(spec, password);
      busy.close();
      if (result.needPassword) {
        password = await this.askSudoPassword(password);
        if (!password) return false;
        continue;
      }
      if (result.code === 0) {
        if (doneText) toast(doneText, { type: 'success' });
        return true;
      }
      toast(result.error || summarizeFailure(result.output) || `Failed (exit code ${result.code ?? 'unknown'})`, { type: 'error' });
      return false;
    }
  }

  async askSudoPassword(previous) {
    const res = await promptDialog({
      title: 'Password needed',
      message: previous
        ? 'That password was not accepted. Please try again.'
        : `This needs administrator (sudo) rights. Enter the password for ${this.server.username} on ${this.server.host}.`,
      type: 'password',
      confirmText: 'Continue',
    });
    return res && res.value ? res.value : null;
  }

  afterSoftwareChange() {
    for (const tab of ['overview', 'services', 'docker', 'websites', 'ports', 'processes']) this.loaded.delete(tab);
    if (this.status === 'connected') this.loadTab('apps');
  }

  refreshTab(tab) {
    if (this.status !== 'connected') return;
    if (this.tab === tab) {
      this.loaded.add(tab);
      this.loadTab(tab);
    } else {
      this.loaded.delete(tab);
    }
  }

  // Runs one attempt of a job and collects its output. Resolves with { code, needPassword, error, output }.
  execJob(spec, password, onData) {
    return new Promise((resolve) => {
      const jobId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      let output = '';
      installJobs.set(jobId, {
        data: (chunk) => {
          output += chunk;
          onData?.(chunk);
        },
        exit: (result) => {
          installJobs.delete(jobId);
          resolve({ ...result, output });
        },
      });
      api.startJob(this.server.id, jobId, spec, password).catch((err) => {
        installJobs.delete(jobId);
        resolve({ code: null, error: err.message, output });
      });
    });
  }

  // Shows a live log window for one attempt of a job. Resolves with { ok } or { needPassword }.
  showJob(spec, { title, password, busyMessage, doneMessage }) {
    return new Promise((resolve) => {
      let running = true;
      const log = h('pre', { class: 'preview install-log' });
      const status = h(
        'div',
        { class: 'install-status' },
        h('div', { class: 'spinner' }),
        h('span', {}, busyMessage || 'Working… This can take a few minutes. Keep the app open and connected.')
      );
      const closeBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => close() }, 'Close');
      const close = openModal({
        title,
        subtitle: this.server.name,
        body: h('div', { class: 'install-body' }, status, log),
        footer: [closeBtn],
        wide: true,
        canClose: () => !running,
      });
      const append = (chunk) => {
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        log.append(chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r+\n/g, '\n').replace(/\r/g, '\n'));
        if (atBottom) log.scrollTop = log.scrollHeight;
      };
      this.execJob(spec, password, append).then((result) => {
        running = false;
        if (result.needPassword) {
          close();
          resolve({ needPassword: true });
          return;
        }
        const ok = result.code === 0;
        closeBtn.disabled = false;
        if (!log.textContent && ok) log.textContent = '(no output)';
        status.className = `install-status ${ok ? 'success' : 'error'}`;
        status.replaceChildren(
          icon(ok ? 'check' : 'alert'),
          h(
            'span',
            {},
            ok
              ? doneMessage || 'Finished successfully.'
              : result.error || `Something went wrong (exit code ${result.code ?? 'unknown'}). The log above shows what happened.`
          )
        );
        resolve({ ok });
      });
    });
  }

  // ----- Service & container controls -----

  serviceActions(s, system) {
    const running = s.active === 'active';
    const isSsh = /^(ssh|sshd)$/.test(s.name);
    return h(
      'div',
      { class: 'row-buttons' },
      running
        ? h('button', { class: 'btn small', onclick: () => this.serviceAction(s.name, 'restart') }, 'Restart')
        : h('button', { class: 'btn small', onclick: () => this.serviceAction(s.name, 'start') }, 'Start'),
      running
        ? h(
            'button',
            {
              class: 'btn small',
              disabled: isSsh,
              title: isSsh ? 'Stopping SSH would disconnect you from the server' : null,
              onclick: () => this.serviceAction(s.name, 'stop'),
            },
            'Stop'
          )
        : null,
      system === 'systemd'
        ? h(
            'button',
            {
              class: 'btn small',
              onclick: () =>
                this.runJob(
                  { kind: 'serviceLogs', name: s.name },
                  { title: `Logs: ${s.name}`, busyMessage: 'Loading logs…', doneMessage: 'Showing the most recent 300 lines.', after: null }
                ),
            },
            'Logs'
          )
        : null
    );
  }

  async serviceAction(name, action) {
    if (action === 'stop') {
      const ok = await confirmDialog({
        title: `Stop ${name}?`,
        message: `${name}, and anything that depends on it, stops working until you start it again.`,
        confirmText: 'Stop',
        danger: true,
      });
      if (!ok) return;
    }
    const [busy, done] = { start: ['Starting', 'started'], stop: ['Stopping', 'stopped'], restart: ['Restarting', 'restarted'] }[action];
    await this.runQuickJob({ kind: 'service', name, action }, { busyText: `${busy} ${name}…`, doneText: `${name} ${done}` });
    for (const tab of ['overview', 'websites', 'ports', 'processes']) this.loaded.delete(tab);
    if (this.status === 'connected') {
      this.load('services', () => api.services(this.server.id), (p, d) => this.renderServices(p, d), '', { quiet: true });
    }
  }

  // Loads this server's notes alongside the tab's own data, so rows know whether one exists.
  async withNotes(promise) {
    const [data, saved, caps] = await Promise.all([
      promise,
      api.notesList(this.server.id).catch(() => []),
      api.capabilities(this.server.id).catch(() => null),
    ]);
    this.notesIndex = new Map(saved.map((n) => [`${n.kind}:${n.key}`, n]));
    if (caps) this.caps = caps;
    return data;
  }

  // Why an action is unavailable for the account this session is connected as, or null when it is.
  denyReason(what = 'act') {
    const c = this.caps;
    if (!c) return null;
    if (what === 'docker' ? c.canDocker : c.canAct) return null;
    return what === 'docker'
      ? `${c.user} is not in the docker group and cannot use sudo, so Docker actions are not available.`
      : `${c.user} cannot run commands as root on this server, so this is view-only.`;
  }

  // Disables the buttons inside an actions cell, keeping the reason on the tooltip.
  gateActions(el, reason) {
    if (reason) {
      for (const b of el.querySelectorAll('button')) {
        b.disabled = true;
        b.title = reason;
      }
    }
    return el;
  }

  // `item` is the row this note belongs to. Only the Docker tab passes one, and only then can the
  // note be generated: it is what tells the job which thing to inspect on the server.
  noteButton(kind, key, item) {
    const note = this.notesIndex?.get(`${kind}:${key}`);
    return h(
      'button',
      {
        class: `btn small ${note ? 'primary' : ''}`,
        title: note ? note.title : 'Save connection details, credentials or setup notes for this item',
        onclick: () => this.openNote(kind, key, item),
      },
      icon('file'),
      'Info'
    );
  }

  openNote(kind, key, item) {
    const existing = this.notesIndex?.get(`${kind}:${key}`) || null;
    const title = h('input', { class: 'input', placeholder: 'e.g. Grafana and Kibana logins', value: existing?.title || '' });
    const body = h('textarea', {
      class: 'input',
      rows: 14,
      spellcheck: false,
      style: { fontFamily: 'var(--mono)', minHeight: '240px', resize: 'vertical' },
    });
    body.value = existing?.body || '';
    const onServer = h('input', { type: 'checkbox', checked: Boolean(existing?.onServer) });
    // The label says where the copy goes and who can read it, which depends on whether this server's
    // notes have been shared with a group.
    const serverLabel = h('span', {}, 'Also save a readable copy on the server. That copy is plain text.');
    const refreshShare = async () => {
      try {
        const st = await api.notesShareStatus(this.server.id);
        serverLabel.textContent = st.shared
          ? `Also save a copy in ${st.sharedDir}, readable by everyone in the group ${st.group}. That copy is plain text.`
          : `Also save a copy in ${st.homeDir}, readable only by this login. That copy is plain text.`;
        shareBtn.hidden = st.shared;
      } catch {
        shareBtn.hidden = true;
      }
    };
    const shareBtn = h('button', { class: 'btn small', type: 'button', hidden: true, onclick: () => this.shareNotes(refreshShare) }, icon('users'), 'Share with a group…');
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const saveBtn = h('button', { class: 'btn primary', onclick: () => save() }, 'Save');
    const showError = (message) => {
      errorEl.replaceChildren(icon('alert'), h('div', {}, message));
      errorEl.hidden = false;
    };
    // A copy that failed to save stays ticked, so say why it is missing until a save succeeds.
    if (existing?.serverError) showError(existing.serverError);
    const save = async () => {
      errorEl.hidden = true;
      if (!title.value.trim()) return showError('Give this note a short title.');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const note = await api.notesSave(this.server.id, { kind, key, title: title.value, body: body.value, onServer: onServer.checked });
        (this.notesIndex ||= new Map()).set(`${kind}:${key}`, note);
        close();
        if (note.serverError) toast(note.serverError, { type: 'error' });
        else toast('Info saved', { type: 'success' });
        this.refreshTab(NOTE_TABS[kind] || 'docker');
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        showError(err.message);
      }
      return undefined;
    };
    const remove = async () => {
      const ok = await confirmDialog({ title: `Delete the info for ${key}?`, message: 'The note is removed from this PC, and from the server if a copy was saved there.', confirmText: 'Delete', danger: true });
      if (!ok) return;
      await api.notesDelete(this.server.id, kind, key).catch((err) => toast(err.message, { type: 'error' }));
      this.notesIndex?.delete(`${kind}:${key}`);
      close();
      this.refreshTab(NOTE_TABS[kind] || 'docker');
    };
    const close = openModal({
      title: `Info for ${key}`,
      wide: true,
      body: h(
        'div',
        { class: 'form-stack' },
        errorEl,
        h('div', { class: 'field' }, h('label', {}, 'Title'), title),
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'field-head' }, h('label', {}, 'Details'), this.generateNoteButton(item, body, errorEl)),
          body,
          h('div', { class: 'help' }, 'Connection strings, logins, ports, how to start it again. Kept encrypted on this PC.')
        ),
        h('div', { class: 'field-head' }, h('label', { class: 'checkbox' }, onServer, serverLabel), shareBtn)
      ),
      footer: [
        existing ? h('button', { class: 'btn', onclick: () => remove() }, 'Delete') : null,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        saveBtn,
      ].filter(Boolean),
    });
    setTimeout(() => title.focus(), 30);
    refreshShare();
  }

  // Moves this server's note copies into a team folder one group can read and update, so Server
  // Explorer on teammates' PCs picks them up. Creating the folder needs root, so it runs as a job.
  async shareNotes(onDone) {
    let groups;
    try {
      groups = (await api.users(this.server.id)).groups || [];
    } catch (err) {
      toast(err.message, { type: 'error' });
      return;
    }
    if (!groups.length) {
      toast('Create a group under Users first, then share notes with it.', { type: 'error' });
      return;
    }
    const home = await api.home(this.server.id).catch(() => '');
    const select = h(
      'select',
      { class: 'input' },
      ...groups.map((g) => h('option', { value: g.name }, g.members.length ? `${g.name} (${g.members.join(', ')})` : `${g.name} (nobody yet)`))
    );
    const confirmed = await new Promise((resolve) => {
      let result = false;
      const close = openModal({
        title: 'Share notes with a group',
        body: h(
          'div',
          { class: 'form-stack' },
          h('p', {}, 'Server copies of notes move to /srv/server-explorer/notes. Everyone in the group can read and update them, and Server Explorer on their PCs shows them.'),
          notice('These copies are plain text and usually hold passwords. Pick a group you would hand those passwords to.'),
          h('div', { class: 'field' }, h('label', {}, 'Group'), select)
        ),
        footer: [
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => ((result = true), close()) }, 'Share'),
        ],
        onClose: () => resolve(result),
      });
    });
    if (!confirmed) return;
    const group = select.value;
    if (await this.userJob({ kind: 'notesShare', group, from: `${home}/.server-explorer/notes` }, { title: `Sharing notes with ${group}`, doneText: `Notes are shared with ${group}` })) {
      await onDone?.();
      this.refreshTab('docker');
    }
  }

  // Only Docker rows carry an `item`, so only they can be generated: it is what tells the inspect
  // job which thing to look at. Other notes keep the dialog they always had.
  generateNoteButton(item, bodyEl, errorEl) {
    if (!item?.target) return null;
    const btn = h('button', { class: 'btn small', type: 'button' }, icon('sparkles'), 'Generate with AI');
    btn.onclick = () => this.generateNote(btn, item, bodyEl, errorEl);
    return btn;
  }

  async generateNote(btn, item, bodyEl, errorEl) {
    const reset = () => {
      btn.disabled = false;
      btn.replaceChildren(icon('sparkles'), 'Generate with AI');
    };
    const fail = (message) => {
      errorEl.replaceChildren(icon('alert'), h('div', {}, message));
      errorEl.hidden = false;
      reset();
    };
    errorEl.hidden = true;
    btn.disabled = true;
    btn.replaceChildren(icon('sparkles'), 'Reading the server…');

    // The app collects the facts itself instead of letting the assistant run commands, so nothing
    // needs approving while this modal is open.
    const res = await this.execJob({ kind: 'dockerInspect', target: item.target, id: item.id });
    if (res.needPassword) return fail('This needs administrator rights on the server, so it cannot be read from here.');
    if (res.code !== 0) return fail((res.output || res.error || 'docker inspect failed.').trim().slice(0, 300));

    let facts;
    try {
      facts = this.summariseInspect(res.output);
    } catch {
      return fail('Could not read what docker returned.');
    }
    if (!facts.length) return fail('docker returned nothing to describe.');

    btn.replaceChildren(icon('sparkles'), 'Writing…');
    const prompt = [
      `Write short notes for a teammate on how to CONNECT TO and USE this ${item.target}, from the facts below.`,
      '',
      `It runs on the server ${this.server.username}@${this.server.host}.`,
      '',
      'Rules:',
      '- Lead with what someone needs to reach it: URL or host:port, username, password, and a ready-to-paste connection string or command where one applies.',
      '- Take credentials exactly as they appear in the environment variables. Do not invent, guess or mask them.',
      '- Say which ports are published to the outside and which are only reachable inside Docker.',
      '- Short headings and plain lines. No preamble, no closing summary.',
      '- If something a person would need is not in the facts, say so in one line instead of filling it in.',
      '',
      'Facts:',
      JSON.stringify(facts, null, 1),
    ].join('\n');

    try {
      const text = await this.askAiOnce(prompt);
      bodyEl.value = bodyEl.value.trim() ? `${bodyEl.value.trim()}\n\n${text}` : text;
      bodyEl.scrollTop = bodyEl.scrollHeight;
      reset();
    } catch (err) {
      fail(err.message);
    }
    return undefined;
  }

  // The parts of `docker inspect` that say how to reach something. Everything else is noise here,
  // and the raw JSON is far too big to send whole.
  summariseInspect(raw) {
    const text = String(raw || '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end < start) throw new Error('no json');
    const parsed = JSON.parse(text.slice(start, end + 1));
    return (Array.isArray(parsed) ? parsed : [parsed]).map((x) => {
      const cfg = x.Config || {};
      const ports = [];
      for (const [inner, binds] of Object.entries(x.NetworkSettings?.Ports || {})) {
        if (binds?.length) for (const b of binds) ports.push(`${b.HostIp || '0.0.0.0'}:${b.HostPort} -> ${inner}`);
        else ports.push(`${inner} (inside Docker only)`);
      }
      return {
        name: String(x.Name || '').replace(/^\//, '') || String(x.Id || '').slice(0, 12),
        image: cfg.Image || (x.RepoTags || [])[0] || '',
        state: x.State?.Status || '',
        ports: ports.length ? ports : Object.keys(cfg.ExposedPorts || {}),
        env: cfg.Env || [],
        mounts: (x.Mounts || []).map((m) => `${m.Source} -> ${m.Destination}${m.RW === false ? ' (read-only)' : ''}`),
        cmd: cfg.Cmd || null,
        composeProject: (cfg.Labels || {})['com.docker.compose.project'] || '',
      };
    });
  }

  // A one-off question on its own chat, so the AI tab's conversation is left alone. Tool requests
  // are denied rather than shown: there is no approval UI in this modal, and an unanswered request
  // would leave the button spinning forever.
  async askAiOnce(prompt, { timeoutMs = 120000 } = {}) {
    const chatId = await api.aiCreateChat(this.server.id);
    try {
      return await new Promise((resolve, reject) => {
        let text = '';
        let settled = false;
        const finish = (err, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          off();
          if (err) reject(err);
          else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('The assistant took too long to answer.')), timeoutMs);
        const off = api.onAiEvent((event) => {
          if (event.chatId !== chatId) return;
          if (event.type === 'text') text += event.delta;
          else if (event.type === 'request') api.aiRespond(chatId, event.request.id, { decision: 'deny' }).catch(() => {});
          else if (event.type === 'turn-end') {
            if (event.error) finish(new Error(event.error));
            else if (!text.trim()) finish(new Error('The assistant did not send any text back.'));
            else finish(null, text.trim());
          }
        });
        api.aiSend(chatId, prompt).catch((err) => finish(err));
      });
    } finally {
      api.aiDisposeChat(chatId).catch(() => {});
    }
  }

  containerActions(c) {
    const running = c.state === 'running';
    return h(
      'div',
      { class: 'row-buttons' },
      running
        ? h('button', { class: 'btn small', onclick: () => this.containerAction(c, 'restart') }, 'Restart')
        : h('button', { class: 'btn small', onclick: () => this.containerAction(c, 'start') }, 'Start'),
      running ? h('button', { class: 'btn small', onclick: () => this.containerAction(c, 'stop') }, 'Stop') : null,
      h(
        'button',
        {
          class: 'btn small',
          onclick: () =>
            this.runJob(
              { kind: 'containerLogs', id: c.id },
              { title: `Logs: ${c.name}`, busyMessage: 'Loading logs…', doneMessage: 'Showing the most recent 300 lines.', after: null }
            ),
        },
        'Logs'
      ),
      running && this.dbEngineFor(c.image)
        ? h('button', { class: 'btn small', title: 'Browse this database, read-only, through SSH', onclick: () => this.exploreDb(c) }, icon('search'), 'Explore')
        : null,
      this.noteButton('container', c.name, { target: 'container', id: c.id || c.name, label: c.name })
    );
  }

  // Which explorer a container's image can use, or null. Matched on the image name: environment
  // and ports differ from one setup to the next, the image does not.
  dbEngineFor(image) {
    const name = String(image || '');
    if (/(^|\/)elasticsearch(:|$)/.test(name)) return 'elasticsearch';
    if (/(^|\/)mongo(:|$)/.test(name)) return 'mongodb';
    if (/(^|\/)mssql\/server(:|$)/.test(name)) return 'mssql';
    return null;
  }

  async exploreDb(c) {
    const engine = this.dbEngineFor(c.image);
    const busy = toast(`Reading ${c.name}…`, { busy: true });
    const res = await this.execJob({ kind: 'dockerInspect', target: 'container', id: c.id || c.name });
    busy.close();
    if (res.needPassword || res.code !== 0) {
      toast((res.output || res.error || `Could not read ${c.name}.`).trim().slice(0, 200), { type: 'error' });
      return;
    }
    let target;
    try {
      target = this.dbTarget(res.output, engine);
    } catch (err) {
      toast(err.message, { type: 'error' });
      return;
    }
    // Reload notes first: the login in the Info note may have been changed from another PC.
    try {
      const saved = await api.notesList(this.server.id);
      this.notesIndex = new Map(saved.map((n) => [`${n.kind}:${n.key}`, n]));
    } catch {
      // The notes already loaded will do.
    }
    const fromNote = this.dbLoginFromNote(engine, this.notesIndex?.get(`container:${c.name}`)?.body, target.username);
    if (fromNote) Object.assign(target, fromNote, { source: 'the Info note' });
    this.openDbExplorer(c, engine, target);
  }

  // Where the database answers as seen from the server, plus the login its container was started with.
  dbTarget(raw, engine) {
    const text = String(raw || '');
    const x = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1))[0];
    const env = Object.fromEntries(
      (x.Config?.Env || []).map((e) => {
        const i = e.indexOf('=');
        return [e.slice(0, i), e.slice(i + 1)];
      })
    );
    const port = DB_ENGINES[engine].port;
    const v4 = (x.NetworkSettings?.Ports?.[`${port}/tcp`] || []).find((b) => !String(b.HostIp).includes(':'));
    let host;
    let hostPort;
    if (v4) {
      host = !v4.HostIp || v4.HostIp === '0.0.0.0' ? '127.0.0.1' : v4.HostIp;
      hostPort = Number(v4.HostPort);
    } else {
      // Not published: the server can still reach the container on its Docker network.
      host = Object.values(x.NetworkSettings?.Networks || {})
        .map((n) => n.IPAddress)
        .find(Boolean);
      if (!host) throw new Error('This container has no address the server can reach.');
      hostPort = port;
    }
    const login = {
      elasticsearch: { username: env.ELASTIC_PASSWORD ? 'elastic' : '', password: env.ELASTIC_PASSWORD || '' },
      mongodb: { username: env.MONGO_INITDB_ROOT_USERNAME || '', password: env.MONGO_INITDB_ROOT_PASSWORD || '', authSource: 'admin' },
      mssql: { username: 'sa', password: env.MSSQL_SA_PASSWORD || env.SA_PASSWORD || '' },
    }[engine];
    return { host, port: hostPort, ...login, source: login.password ? "the container's settings" : '' };
  }

  // A login written in the container's Info note. People keep that current, while the container's
  // start-up settings only record the first password. The line the explorer saves wins over the rest.
  dbLoginFromNote(engine, body, preferUser) {
    const text = String(body || '');
    const parse = {
      elasticsearch: (s) => {
        const m = s.match(/https?:\/\/([^:@\s/]+):([^@\s]+)@/) || s.match(/-u\s+['"]?([^:\s'"]+):([^\s'"]+)/);
        return m ? { username: decodeURIComponent(m[1]), password: decodeURIComponent(m[2]) } : null;
      },
      mongodb: (s) => {
        const logins = [...s.matchAll(/mongodb:\/\/([^:@/\s]+):([^@\s]+)@[^\s/]+\/?([^\s?`'")]*)(\?[^\s`'")]*)?/g)].map((m) => ({
          username: decodeURIComponent(m[1]),
          password: decodeURIComponent(m[2]),
          authSource: new URLSearchParams((m[4] || '').slice(1)).get('authSource') || m[3] || 'admin',
        }));
        // The explorer lists every database, which needs an account that authenticates against admin.
        return logins.find((l) => l.authSource === 'admin' && (!preferUser || l.username === preferUser)) || logins.find((l) => l.authSource === 'admin') || null;
      },
      mssql: (s) => {
        let m = s.match(/(?:User ?Id|UID)\s*=\s*([^;\n]+?)\s*;[^\n]*?(?:Password|PWD)\s*=\s*(\{(?:[^}]|\}\})*\}|[^;\n"'`]+)/i);
        if (m) return { username: m[1].trim(), password: m[2].startsWith('{') ? m[2].slice(1, -1).replace(/\}\}/g, '}') : m[2].trim() };
        m = s.match(/-U\s+['"]?([^\s'"]+)['"]?\s+-P\s+(?:'([^']*)'|"([^"]*)"|(\S+))/);
        return m ? { username: m[1], password: m[2] ?? m[3] ?? m[4] } : null;
      },
    }[engine];
    const managed = text.match(/^Explorer login: (.+)$/m);
    return (managed && parse(managed[1])) || parse(text);
  }

  // The login as a line a person can also paste into a client.
  dbLoginLine(engine, target, username, password) {
    const u = encodeURIComponent(username);
    const p = encodeURIComponent(password);
    if (engine === 'mongodb') return `mongodb://${u}:${p}@${target.host}:${target.port}/?authSource=${encodeURIComponent(target.authSource || 'admin')}`;
    if (engine === 'elasticsearch') return `http://${u}:${p}@${target.host}:${target.port}`;
    const braced = (v) => (/[;{}]/.test(v) ? `{${v.replace(/\}/g, '}}')}}` : v);
    return `Server=${target.host},${target.port};User Id=${braced(username)};Password=${braced(password)};TrustServerCertificate=True`;
  }

  // Keeps the Info note current with a login that just worked, so the next explorer uses it. The
  // note's title and its server-copy setting are left as they were.
  async saveDbLogin(c, engine, target, username, password) {
    const existing = this.notesIndex?.get(`container:${c.name}`) || null;
    const line = `Explorer login: ${this.dbLoginLine(engine, target, username, password)}`;
    const body = existing?.body || '';
    const next = /^Explorer login: .*$/m.test(body) ? body.replace(/^Explorer login: .*$/m, () => line) : body.trim() ? `${body.trimEnd()}\n\n${line}\n` : `${line}\n`;
    try {
      const note = await api.notesSave(this.server.id, { kind: 'container', key: c.name, title: existing?.title || `${c.name} login`, body: next, onServer: Boolean(existing?.onServer) });
      (this.notesIndex ||= new Map()).set(`container:${c.name}`, note);
      if (note.serverError) toast(note.serverError, { type: 'error' });
      else toast(`Saved this login to the Info for ${c.name}`, { type: 'success' });
    } catch (err) {
      toast(`The login worked but could not be saved to the Info note: ${err.message}`, { type: 'error' });
    }
  }

  openDbExplorer(c, engine, target) {
    const meta = DB_ENGINES[engine];
    const s = { id: null, levels: 1, databases: [], database: null, items: [], item: null, from: 0, showHidden: false };
    const prefilled = { username: target.username, password: target.password };
    const where = `${target.host}:${target.port}`;
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const showError = (message) => {
      errorEl.replaceChildren(icon('alert'), h('div', {}, message));
      errorEl.hidden = false;
    };
    const infoEl = h('div', { class: 'help' }, `Connecting through SSH to ${where} on the server…`);
    const user = h('input', { class: 'input', placeholder: 'Username', value: target.username });
    const pass = h('input', { class: 'input', type: 'password', placeholder: 'Password' });
    pass.value = target.password;
    const connectBtn = h('button', { class: 'btn primary', onclick: () => connect() }, 'Connect');
    const loginRow = h('div', { class: 'db-login', hidden: true }, user, pass, connectBtn);

    const hiddenBox = h('input', { type: 'checkbox' });
    const dbSelect = h('select', { class: 'input', hidden: true });
    const itemList = h('div', { class: 'db-index-list' });
    const query = h('input', { class: 'input', placeholder: meta.queryHint });
    const runBtn = h('button', { class: 'btn', disabled: true, onclick: () => ((s.from = 0), run()) }, icon('search'), meta.runLabel);
    const schemaBtn = h('button', { class: 'btn', disabled: true, onclick: () => showSchema() }, meta.schemaLabel);
    const titleEl = h('div', { class: 'db-title' }, `No ${meta.itemWord} selected`);
    const results = h('div', { class: 'db-results' }, h('div', { class: 'card empty' }, `Pick ${meta.article} ${meta.itemWord} on the left.`));
    const prevBtn = h('button', { class: 'btn small', onclick: () => ((s.from = Math.max(0, s.from - meta.pageSize)), run()) }, 'Previous');
    const nextBtn = h('button', { class: 'btn small', onclick: () => ((s.from += meta.pageSize), run()) }, 'Next');
    const pageEl = h('span', { class: 'muted' });
    const pager = h('div', { class: 'db-pager', hidden: true }, prevBtn, pageEl, nextBtn);
    const workspace = h(
      'div',
      { class: 'db-explorer', hidden: true },
      h('div', { class: 'db-side' }, h('label', { class: 'checkbox' }, hiddenBox, 'Show system items'), dbSelect, itemList),
      h('div', { class: 'db-main' }, titleEl, h('div', { class: 'db-toolbar' }, query, runBtn, schemaBtn), results, pager)
    );

    const visible = (list) => list.filter((x) => s.showHidden || !x.hidden);
    const updateButtons = () => {
      runBtn.disabled = !(s.item || (meta.queryWithoutItem && s.database));
      schemaBtn.disabled = !s.item;
    };
    const health = { green: 'green', yellow: 'amber', red: 'red' };
    const drawDatabases = () => {
      const list = visible(s.databases);
      dbSelect.replaceChildren(...list.map((d) => h('option', { value: d.name }, d.bytes ? `${d.name} (${fmtBytes(d.bytes)})` : d.name)));
      if (s.database && list.some((d) => d.name === s.database)) dbSelect.value = s.database;
    };
    const drawItems = () => {
      const list = visible(s.items);
      const hiddenCount = s.items.filter((x) => x.hidden).length;
      itemList.replaceChildren(
        ...(list.length
          ? list.map((x) =>
              h(
                'button',
                { class: `db-index ${s.item && x.name === s.item.name ? 'active' : ''}`, onclick: () => pickItem(x) },
                h('span', { class: 'db-index-name' }, x.name),
                h(
                  'span',
                  { class: 'db-index-meta' },
                  x.badge ? h('span', { class: `badge ${meta.health ? health[x.badge] || 'red' : ''}` }, x.badge) : null,
                  [x.count == null ? '' : `${x.count.toLocaleString()} ${meta.countWord}`, x.bytes ? fmtBytes(x.bytes) : ''].filter(Boolean).join(' · ')
                )
              )
            )
          : [h('div', { class: 'card empty' }, hiddenCount ? `Only system ${meta.itemsWord} here (${hiddenCount}). Tick the box above to see them.` : `No ${meta.itemsWord} here.`)])
      );
    };
    const loadItems = async () => {
      s.item = null;
      s.from = 0;
      updateButtons();
      itemList.replaceChildren(loadingEl(`Loading ${meta.itemsWord}…`));
      try {
        s.items = await api.dbCollections(s.id, s.database);
        drawItems();
      } catch (err) {
        itemList.replaceChildren();
        showError(err.message);
      }
      updateButtons();
    };
    const pickDatabase = async () => {
      const list = visible(s.databases);
      if (!list.some((d) => d.name === s.database)) s.database = list[0] ? list[0].name : null;
      drawDatabases();
      if (s.database) await loadItems();
      else {
        s.items = [];
        s.item = null;
        itemList.replaceChildren(h('div', { class: 'card empty' }, 'Only system databases here. Tick the box above to see them.'));
        updateButtons();
      }
    };
    const loadDatabases = async () => {
      dbSelect.hidden = false;
      itemList.replaceChildren(loadingEl('Loading databases…'));
      try {
        s.databases = await api.dbDatabases(s.id);
        await pickDatabase();
      } catch (err) {
        itemList.replaceChildren();
        showError(err.message);
      }
    };
    const docEl = (row) =>
      h(
        'details',
        { class: 'db-doc' },
        h('summary', {}, h('span', { class: 'mono db-doc-id', title: String(row.id) }, row.id), h('span', { class: 'muted db-doc-preview' }, JSON.stringify(row.source ?? null).slice(0, 200))),
        h('pre', { class: 'preview' }, JSON.stringify(row.source ?? null, null, 2))
      );
    const gridEl = (r) =>
      h(
        'div',
        { class: 'db-grid' },
        h(
          'table',
          { class: 'data' },
          h('thead', {}, h('tr', {}, ...r.columns.map((col) => h('th', {}, col)))),
          h('tbody', {}, ...r.rows.map((row) => h('tr', {}, ...row.map((v) => h('td', { title: v.length > 40 ? v : null }, v.length > 300 ? `${v.slice(0, 300)}…` : v)))))
        )
      );
    const run = async () => {
      if (!s.id) return;
      const q = query.value.trim();
      const freeQuery = Boolean(meta.queryWithoutItem && q && s.database);
      if (!s.item && !freeQuery) return;
      errorEl.hidden = true;
      titleEl.textContent = freeQuery ? `Query on ${s.database}` : s.item.name;
      runBtn.disabled = true;
      schemaBtn.disabled = true;
      results.replaceChildren(loadingEl('Loading…'));
      try {
        const r = await api.dbBrowse(s.id, { database: s.database, ref: s.item?.ref, query: q, from: s.from, size: meta.pageSize });
        s.from = r.from;
        const end = r.from + r.rows.length;
        pager.hidden = !r.paged || !r.total;
        if (r.paged) {
          pageEl.textContent = r.total ? `${(r.from + 1).toLocaleString()}–${end.toLocaleString()} of ${r.total.toLocaleString()}` : '';
          prevBtn.disabled = r.from === 0;
          nextBtn.disabled = end >= r.total || r.from >= r.maxFrom;
        }
        if (!r.rows.length) results.replaceChildren(h('div', { class: 'card empty' }, q ? 'Nothing matches.' : `This ${meta.itemWord} is empty.`));
        else if (r.kind === 'rows') results.replaceChildren(gridEl(r));
        else results.replaceChildren(...r.rows.map(docEl));
        if (r.truncated) results.append(h('div', { class: 'help' }, `Showing the first ${r.rows.length} rows. Narrow the query to see the rest.`));
        if (r.paged && r.from >= r.maxFrom && end < r.total) {
          results.append(h('div', { class: 'help' }, 'Only the first 10,000 results can be paged through. Narrow the search to reach the rest.'));
        }
      } catch (err) {
        results.replaceChildren();
        pager.hidden = true;
        showError(err.message);
      } finally {
        updateButtons();
      }
    };
    const pickItem = (x) => {
      s.item = x;
      s.from = 0;
      drawItems();
      run();
    };
    const showSchema = async () => {
      if (!s.item || !s.id) return;
      errorEl.hidden = true;
      pager.hidden = true;
      titleEl.textContent = `${s.item.name} · ${meta.schemaLabel.toLowerCase()}`;
      results.replaceChildren(loadingEl('Loading…'));
      try {
        results.replaceChildren(h('pre', { class: 'preview' }, JSON.stringify(await api.dbSchema(s.id, { database: s.database, ref: s.item.ref }), null, 2)));
      } catch (err) {
        results.replaceChildren();
        showError(err.message);
      }
    };
    const connect = async () => {
      errorEl.hidden = true;
      connectBtn.disabled = true;
      infoEl.textContent = `Connecting through SSH to ${where} on the server…`;
      const username = user.value.trim();
      const password = pass.value;
      const typed = username !== prefilled.username || password !== prefilled.password;
      try {
        if (s.id) api.dbClose(s.id).catch(() => {});
        s.id = null;
        const opened = await api.dbOpen(this.server.id, { engine, host: target.host, port: target.port, username, password, authSource: target.authSource });
        s.id = opened.id;
        s.levels = opened.levels;
        const i = opened.info;
        infoEl.textContent = [
          `${i.product} ${i.version}`.trim(),
          i.detail,
          `read-only, through SSH to ${where} on the server`,
          typed ? 'login you entered' : target.source ? `login from ${target.source}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        loginRow.hidden = true;
        workspace.hidden = false;
        if (typed) {
          prefilled.username = username;
          prefilled.password = password;
          this.saveDbLogin(c, engine, target, username, password);
        }
        if (s.levels > 1) await loadDatabases();
        else await loadItems();
      } catch (err) {
        infoEl.textContent = 'Not connected.';
        loginRow.hidden = false;
        workspace.hidden = true;
        showError(err.message);
      } finally {
        connectBtn.disabled = false;
      }
    };

    hiddenBox.addEventListener('change', () => {
      s.showHidden = hiddenBox.checked;
      if (s.levels > 1) {
        const before = s.database;
        drawDatabases();
        if (!visible(s.databases).some((d) => d.name === before)) pickDatabase();
      }
      drawItems();
    });
    dbSelect.addEventListener('change', () => {
      s.database = dbSelect.value;
      loadItems();
    });
    query.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ((s.from = 0), run());
    });
    const close = openModal({
      title: `Explore ${c.name}`,
      subtitle: this.server.name,
      wide: true,
      body: h('div', { class: 'db-body' }, errorEl, infoEl, loginRow, workspace),
      footer: [h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => close() }, 'Close')],
      onClose: () => {
        if (s.id) api.dbClose(s.id).catch(() => {});
        s.id = null;
      },
    });
    connect();
  }

  async removeImage(i) {
    const label = i.repository && i.repository !== '<none>' ? `${i.repository}:${i.tag}` : i.id;
    const ok = await confirmDialog({
      title: `Remove image ${label}?`,
      message:
        'The image is deleted from this server and has to be pulled or built again to come back. If a container still needs it, nothing is removed and the reason is shown.',
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await this.runQuickJob({ kind: 'imageRemove', id: i.id }, { busyText: `Removing ${label}…`, doneText: `${label} removed` });
    // Only the image list can change here, so the other tabs are left as they are.
    if (this.status === 'connected') {
      this.load('docker', () => api.docker(this.server.id), (p, d) => this.renderDocker(p, d), '', { quiet: true });
    }
  }

  async containerAction(c, action) {
    if (action === 'stop') {
      const ok = await confirmDialog({
        title: `Stop container ${c.name}?`,
        message: 'The app in this container stops until you start it again.',
        confirmText: 'Stop',
        danger: true,
      });
      if (!ok) return;
    }
    const [busy, done] = { start: ['Starting', 'started'], stop: ['Stopping', 'stopped'], restart: ['Restarting', 'restarted'] }[action];
    await this.runQuickJob({ kind: 'container', id: c.id, action }, { busyText: `${busy} ${c.name}…`, doneText: `${c.name} ${done}` });
    for (const tab of ['overview', 'websites', 'ports', 'processes']) this.loaded.delete(tab);
    if (this.status === 'connected') {
      this.load('docker', () => api.docker(this.server.id), (p, d) => this.renderDocker(p, d), '', { quiet: true });
    }
  }

  // ----- Websites -----

  renderWebsites(panel, d) {
    if (!d.nginx) {
      panel.replaceChildren(
        emptyState(
          'globe',
          'Websites need Nginx',
          'Nginx is the web server that shows your websites to visitors. Install it to create websites and turn on HTTPS.',
          h('button', { class: 'btn primary', onclick: () => this.installNginxForWebsites() }, icon('download'), 'Install Nginx')
        )
      );
      return;
    }
    const cols = [
      {
        key: 'primary',
        label: 'Website',
        render: (s) =>
          h(
            'div',
            {},
            h('div', { class: 'site-name' }, s.primary || 'Default site'),
            h(
              'div',
              { class: 'stat-detail' },
              s.primary ? (s.aliases.length ? `Also ${s.aliases.join(', ')}` : '') : 'Shown for any address that no other website matches'
            )
          ),
      },
      {
        key: 'target',
        label: 'Shows',
        render: (s) =>
          !s.target
            ? h('span', { class: 'muted' }, '—')
            : s.target.type === 'proxy'
              ? h('span', {}, 'App at ', h('span', { class: 'mono' }, s.target.value.replace(/^https?:\/\//, '')))
              : h('span', {}, 'Files in ', h('span', { class: 'mono' }, s.target.value)),
      },
      {
        key: 'https',
        label: 'HTTPS',
        render: (s) => (s.https ? h('span', { class: 'badge green' }, icon('lock'), 'On') : h('span', { class: 'badge amber' }, 'Off')),
      },
      { key: 'file', label: 'Config file', class: 'truncate mono muted', title: (s) => s.files.join('\n') },
      { key: 'actions', label: '', width: '1%', render: (s) => this.websiteActions(s) },
    ];
    const newBtn = h('button', { class: 'btn primary', onclick: () => this.openNewWebsite() }, icon('plus'), 'New Website');
    const parts = [];
    if (d.unreadable.length) parts.push(notice(`This user can't read some Nginx config files: ${d.unreadable.join(', ')}`));
    parts.push(
      section(
        'Websites',
        h('span', { class: 'count' }, d.sites.length),
        newBtn,
        d.sites.length ? dataTable({ columns: cols, rows: d.sites }) : h('div', { class: 'card empty' }, 'No websites yet. Click New Website to create one.')
      ),
      this.certificatesSection(d),
      h('div', { class: 'app-search-hint', style: { marginTop: '0' } }, "HTTPS certificates are free from Let's Encrypt and renew automatically.")
    );
    panel.replaceChildren(...parts);
  }

  websiteActions(s) {
    return h(
      'div',
      { class: 'row-buttons' },
      s.canHttps && !s.https ? h('button', { class: 'btn small primary', onclick: () => this.enableHttps(s) }, icon('lock'), 'Turn On HTTPS') : null,
      s.canHttps ? h('button', { class: 'btn small', onclick: () => api.openUrl(`${s.https ? 'https' : 'http'}://${s.primary}`) }, 'Open') : null,
      h('button', { class: 'btn small', onclick: () => this.openEditor(s.file) }, 'Edit Config'),
      this.noteButton('website', s.primary || s.file)
    );
  }

  async installNginxForWebsites() {
    const ok = await confirmDialog({
      title: 'Install Nginx?',
      message: `Nginx will be installed on ${this.server.name}. This can take a few minutes.`,
      confirmText: 'Install',
    });
    if (!ok) return;
    if (await this.runJob({ kind: 'catalog', id: 'nginx', action: 'install' }, { title: 'Installing Nginx', doneText: 'Nginx is installed' })) {
      this.refreshTab('websites');
    }
  }

  // Resolves the names from this PC and warns when they don't point to this server.
  async dnsWarning(names) {
    const problems = [];
    let serverIps = [];
    for (const name of names) {
      try {
        const r = await api.dnsCheck(name, this.server.host);
        serverIps = r.serverIps;
        if (!r.serverIps.length || r.matches) continue;
        problems.push(r.domainIps.length ? `${name} points to ${r.domainIps.join(', ')}` : `${name} doesn't point to any server yet`);
      } catch {
        // A failed lookup shouldn't block setup.
      }
    }
    if (!problems.length) return null;
    return `${problems.join('; ')}, but this server's address is ${serverIps.join(', ')}. HTTPS only works once the domain's DNS "A" record points to this server, and changes can take a while. If you use a proxy such as Cloudflare, this can be expected.`;
  }

  openNewWebsite() {
    const domain = h('input', { class: 'input', placeholder: 'example.com', spellcheck: false });
    const www = h('input', { type: 'checkbox', checked: true });
    const wwwText = h('span', {}, 'Also use www.example.com');
    let type = 'proxy';
    const port = h('input', { class: 'input', type: 'number', value: '3000', min: 1, max: 65535 });
    const folder = h('input', { class: 'input', placeholder: '/var/www/example.com', spellcheck: false });
    const https = h('input', { type: 'checkbox', checked: true });
    const email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', value: storedEmail.get(), spellcheck: false });
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const warnEl = h('div', { class: 'notice', hidden: true });
    const typeOptions = h('div', { class: 'auth-options two' });
    const portField = h(
      'div',
      { class: 'field' },
      h('label', {}, 'Port your app listens on'),
      port,
      h('div', { class: 'help' }, 'For example a Node.js app on port 3000. Nginx forwards visitors to it.')
    );
    const folderField = h(
      'div',
      { class: 'field' },
      h('label', {}, 'Folder with your website files'),
      folder,
      h('div', { class: 'help' }, "If the folder doesn't exist yet, it's created with a placeholder page. Upload your files there from the Files tab.")
    );
    const emailField = h(
      'div',
      { class: 'field' },
      h('label', {}, 'Email for certificate notices'),
      email,
      h('div', { class: 'help' }, "The certificate is free from Let's Encrypt and renews automatically. Continuing means you accept the Let's Encrypt terms of service.")
    );
    const createBtn = h('button', { class: 'btn primary', onclick: () => create() }, 'Create Website');
    let dnsChecked = false;

    const cleanDomain = () =>
      domain.value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[/:].*$/, '');
    const resetDns = () => {
      dnsChecked = false;
      warnEl.hidden = true;
      createBtn.textContent = 'Create Website';
    };
    const showError = (message) => {
      errorEl.replaceChildren(icon('alert'), h('div', {}, message));
      errorEl.hidden = false;
    };
    const drawType = () => {
      typeOptions.replaceChildren(
        ...[
          ['proxy', 'My app', 'An app running on a port, like Node.js'],
          ['folder', 'A folder of files', 'HTML or PHP files'],
        ].map(([id, title, desc]) =>
          h(
            'div',
            {
              class: `auth-option ${type === id ? 'active' : ''}`,
              onclick: () => {
                type = id;
                drawType();
              },
            },
            h('strong', {}, title),
            h('span', {}, desc)
          )
        )
      );
      portField.hidden = type !== 'proxy';
      folderField.hidden = type !== 'folder';
    };
    domain.addEventListener('input', () => {
      const d = cleanDomain() || 'example.com';
      wwwText.textContent = d.startsWith('www.') ? 'Also use www (already included)' : `Also use www.${d}`;
      folder.placeholder = `/var/www/${d}`;
      resetDns();
    });
    www.addEventListener('change', resetDns);
    https.addEventListener('change', () => {
      emailField.hidden = !https.checked;
      resetDns();
    });

    const create = async () => {
      errorEl.hidden = true;
      const d = cleanDomain();
      if (!DOMAIN_RE.test(d)) return showError('Enter a domain name like example.com (without http://).');
      const portNumber = Number(port.value);
      if (type === 'proxy' && !(Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535)) {
        return showError('Enter the port your app listens on, like 3000.');
      }
      const folderPath = folder.value.trim() || `/var/www/${d}`;
      if (type === 'folder' && (!/^\/[A-Za-z0-9._/-]+$/.test(folderPath) || folderPath.includes('..'))) {
        return showError('Enter a folder path like /var/www/example.com.');
      }
      const names = [d];
      if (www.checked && !d.startsWith('www.')) names.push(`www.${d}`);
      const mail = email.value.trim();
      const wantHttps = https.checked;
      if (wantHttps && !EMAIL_RE.test(mail)) return showError('Enter an email address for certificate notices.');
      if (wantHttps && !dnsChecked) {
        createBtn.disabled = true;
        createBtn.textContent = 'Checking DNS…';
        const warning = await this.dnsWarning(names);
        createBtn.disabled = false;
        createBtn.textContent = 'Create Website';
        dnsChecked = true;
        if (warning) {
          warnEl.replaceChildren(icon('alert'), h('div', {}, warning));
          warnEl.hidden = false;
          createBtn.textContent = 'Continue Anyway';
          return undefined;
        }
      }
      if (wantHttps) storedEmail.set(mail);
      close();
      const created = await this.runJob(
        { kind: 'createSite', domain: d, www: www.checked, type, port: portNumber, folder: folderPath },
        { title: `Creating ${d}`, doneText: `Website ${d} created`, after: null }
      );
      if (created && wantHttps) {
        await this.runJob({ kind: 'certbot', domains: names, email: mail }, { title: `Turning on HTTPS for ${d}`, doneText: `HTTPS is on for ${d}`, after: null });
      }
      this.refreshTab('websites');
      return undefined;
    };

    drawType();
    const close = openModal({
      title: 'New Website',
      body: h(
        'div',
        { class: 'form-stack' },
        errorEl,
        warnEl,
        h('div', { class: 'field' }, h('label', {}, 'Domain name'), domain, h('label', { class: 'checkbox' }, www, wwwText)),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'What should the website show?'), typeOptions),
        portField,
        folderField,
        h('label', { class: 'checkbox' }, https, "Turn on HTTPS (free certificate from Let's Encrypt)"),
        emailField
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), createBtn],
    });
    for (const input of [domain, port, folder, email]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') create();
      });
    }
    setTimeout(() => domain.focus(), 30);
  }

  enableHttps(site) {
    const email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', value: storedEmail.get(), spellcheck: false });
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const warnEl = h('div', { class: 'notice', hidden: true });
    const goBtn = h('button', { class: 'btn primary', onclick: () => go() }, 'Turn On HTTPS');
    let dnsChecked = false;
    const go = async () => {
      errorEl.hidden = true;
      const mail = email.value.trim();
      if (!EMAIL_RE.test(mail)) {
        errorEl.replaceChildren(icon('alert'), h('div', {}, 'Enter an email address for certificate notices.'));
        errorEl.hidden = false;
        return;
      }
      if (!dnsChecked) {
        goBtn.disabled = true;
        goBtn.textContent = 'Checking DNS…';
        const warning = await this.dnsWarning(site.domains);
        goBtn.disabled = false;
        goBtn.textContent = 'Turn On HTTPS';
        dnsChecked = true;
        if (warning) {
          warnEl.replaceChildren(icon('alert'), h('div', {}, warning));
          warnEl.hidden = false;
          goBtn.textContent = 'Continue Anyway';
          return;
        }
      }
      storedEmail.set(mail);
      close();
      await this.runJob(
        { kind: 'certbot', domains: site.domains, email: mail },
        { title: `Turning on HTTPS for ${site.primary}`, doneText: `HTTPS is on for ${site.primary}`, after: null }
      );
      this.refreshTab('websites');
    };
    const close = openModal({
      title: `Turn on HTTPS for ${site.primary}`,
      body: h(
        'div',
        { class: 'form-stack' },
        errorEl,
        warnEl,
        h(
          'p',
          {},
          `A free certificate from Let's Encrypt will be set up for ${site.domains.join(' and ')}. Visitors are sent to https:// automatically, and the certificate renews by itself.`
        ),
        h(
          'div',
          { class: 'field' },
          h('label', {}, 'Email for certificate notices'),
          email,
          h('div', { class: 'help' }, "Continuing means you accept the Let's Encrypt terms of service.")
        )
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), goBtn],
    });
    email.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    setTimeout(() => email.focus(), 30);
  }

  // ----- Certificates -----

  certificatesSection(d) {
    const certs = d.certs || { certbot: false, readable: true, list: [] };
    const newBtn = h('button', { class: 'btn', onclick: () => this.openNewCertificate(d) }, icon('plus'), 'New Certificate');
    if (!certs.certbot) {
      return section(
        'Certificates',
        null,
        newBtn,
        h('div', { class: 'card empty' }, "No certificates yet. Creating one installs Certbot and gets a free certificate from Let's Encrypt.")
      );
    }
    if (!certs.readable) {
      return section('Certificates', null, newBtn, notice('Certificates can only be listed when connected as root, because only root may read them.'));
    }
    const expiryBadge = (c) => {
      if (c.invalid) return h('span', { class: 'badge red', title: c.expiry }, 'Expired');
      if (c.days == null) return h('span', { class: 'badge' }, c.expiry || '—');
      const tone = c.days <= 0 ? 'red' : c.days <= 14 ? 'amber' : 'green';
      return h('span', { class: `badge ${tone}`, title: c.expiry }, c.days <= 0 ? 'Expired' : `${c.days} days left`);
    };
    const cols = [
      { key: 'name', label: 'Certificate', render: (c) => h('div', { class: 'site-name' }, c.name) },
      {
        key: 'domains',
        label: 'Covers',
        class: 'truncate mono',
        title: (c) => c.domains.join('\n'),
        render: (c) => c.domains.join(', '),
      },
      { key: 'days', label: 'Expires', render: expiryBadge },
      {
        key: 'actions',
        label: '',
        width: '1%',
        render: (c) => h('div', { class: 'row-buttons' }, h('button', { class: 'btn small', onclick: () => this.renewCertificate(c) }, icon('refresh'), 'Renew')),
      },
    ];
    return section(
      'Certificates',
      h('span', { class: 'count' }, certs.list.length),
      newBtn,
      certs.list.length
        ? dataTable({ columns: cols, rows: certs.list })
        : h('div', { class: 'card empty' }, "No certificates yet. Click New Certificate to get a free one from Let's Encrypt.")
    );
  }

  async renewCertificate(cert) {
    const mail = storedEmail.get();
    if (!EMAIL_RE.test(mail)) {
      this.openNewCertificate(null, cert.domains);
      return;
    }
    const ok = await confirmDialog({
      title: `Renew ${cert.name}?`,
      message: `A fresh certificate will be requested from Let's Encrypt for ${cert.domains.join(', ')}.`,
      confirmText: 'Renew',
    });
    if (!ok) return;
    await this.runJob(
      { kind: 'certbot', domains: cert.domains, email: mail },
      { title: `Renewing ${cert.name}`, doneText: `${cert.name} was renewed`, after: null }
    );
    this.refreshTab('websites');
  }

  // Issues a certificate with Certbot's Nginx plugin, so the domain needs a website here already.
  openNewCertificate(d, presetDomains) {
    const sites = (d && d.sites) || [];
    const suggested = (presetDomains || [])[0] || (sites.find((s) => s.canHttps && !s.https) || {}).primary || '';
    const domain = h('input', { class: 'input', placeholder: 'example.com', spellcheck: false, value: suggested });
    const www = h('input', { type: 'checkbox', checked: true });
    const email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', value: storedEmail.get(), spellcheck: false });
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const warnEl = h('div', { class: 'notice', hidden: true });
    const goBtn = h('button', { class: 'btn primary', onclick: () => go() }, 'Get Certificate');
    let dnsChecked = false;
    const cleanDomain = () =>
      domain.value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[/:].*$/, '');
    const showError = (message) => {
      errorEl.replaceChildren(icon('alert'), h('div', {}, message));
      errorEl.hidden = false;
    };
    domain.addEventListener('input', () => {
      dnsChecked = false;
      warnEl.hidden = true;
      goBtn.textContent = 'Get Certificate';
    });
    const go = async () => {
      errorEl.hidden = true;
      const dom = cleanDomain();
      if (!DOMAIN_RE.test(dom)) return showError('Enter a domain name like example.com (without http://).');
      const mail = email.value.trim();
      if (!EMAIL_RE.test(mail)) return showError('Enter an email address for certificate notices.');
      const names = [dom];
      if (www.checked && !dom.startsWith('www.')) names.push(`www.${dom}`);
      if (!dnsChecked) {
        goBtn.disabled = true;
        goBtn.textContent = 'Checking DNS…';
        const warning = await this.dnsWarning(names);
        goBtn.disabled = false;
        goBtn.textContent = 'Get Certificate';
        dnsChecked = true;
        if (warning) {
          warnEl.replaceChildren(icon('alert'), h('div', {}, warning));
          warnEl.hidden = false;
          goBtn.textContent = 'Continue Anyway';
          return undefined;
        }
      }
      storedEmail.set(mail);
      close();
      await this.runJob(
        { kind: 'certbot', domains: names, email: mail },
        { title: `Getting a certificate for ${dom}`, doneText: `Certificate for ${dom} is ready`, after: null }
      );
      this.refreshTab('websites');
      return undefined;
    };
    const close = openModal({
      title: 'New Certificate',
      body: h(
        'div',
        { class: 'form-stack' },
        errorEl,
        warnEl,
        h('p', {}, "Let's Encrypt gives free certificates that renew by themselves. The domain needs a website on this server already, and its DNS must point here."),
        h('div', { class: 'field' }, h('label', {}, 'Domain name'), domain, h('label', { class: 'checkbox' }, www, 'Also cover the www address')),
        h(
          'div',
          { class: 'field' },
          h('label', {}, 'Email for certificate notices'),
          email,
          h('div', { class: 'help' }, "Continuing means you accept the Let's Encrypt terms of service.")
        )
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), goBtn],
    });
    for (const input of [domain, email]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') go();
      });
    }
    setTimeout(() => domain.focus(), 30);
  }

  // ----- Services -----

  renderServices(panel, d) {
    const ui = this.ui('services');
    ui.sort ||= { key: 'name', dir: 1 };
    ui.filter ||= 'running';
    if (!d.list.length) {
      panel.replaceChildren(emptyState('cog', 'No services found', 'Could not list services on this server.'));
      return;
    }
    const filters = {
      running: (s) => s.sub === 'running',
      failed: (s) => s.active === 'failed' || s.sub === 'failed',
      enabled: (s) => s.enabled === 'enabled',
      all: () => true,
    };
    const tabs = [
      ['running', 'Running'],
      ['failed', 'Failed'],
      ['enabled', 'Start on boot'],
      ['all', 'All'],
    ].filter(([k]) => d.system === 'systemd' || k !== 'enabled');
    if (!tabs.some(([k]) => k === ui.filter)) ui.filter = 'running';

    const cols = [
      { key: 'sub', label: 'Status', render: serviceBadge },
      { key: 'name', label: 'Service', class: 'mono nowrap' },
    ];
    if (d.system === 'systemd') {
      cols.push(
        {
          key: 'enabled',
          label: 'Start on boot',
          render: (s) => (s.enabled === 'enabled' ? h('span', { class: 'badge blue' }, 'Yes') : h('span', { class: 'muted' }, s.enabled || '—')),
        },
        { key: 'description', label: 'Description', class: 'truncate muted', title: (s) => s.description }
      );
    }
    // Wrapped rather than changed inside serviceActions, so the existing buttons stay untouched.
    cols.push({
      key: 'actions',
      label: '',
      sortable: false,
      width: '1%',
      render: (s) => h('div', { class: 'row-buttons' }, this.gateActions(this.serviceActions(s, d.system), this.denyReason()), this.noteButton('service', s.name)),
    });
    const t = tableSection({
      ui,
      columns: cols,
      rows: d.list,
      searchKeys: ['name', 'description'],
      placeholder: 'Search services',
      empty: 'No services in this view',
      extraFilter: (s) => filters[ui.filter](s),
    });
    const seg = h('div', { class: 'segmented' });
    const drawSeg = () =>
      seg.replaceChildren(
        ...tabs.map(([k, label]) =>
          h(
            'button',
            {
              class: ui.filter === k ? 'active' : '',
              onclick: () => {
                ui.filter = k;
                drawSeg();
                t.draw();
              },
            },
            label,
            h('span', { class: 'count' }, d.list.filter(filters[k]).length)
          )
        )
      );
    drawSeg();
    t.draw();
    panel.replaceChildren(
      section('Services', h('span', { class: 'hint' }, d.system === 'systemd' ? 'systemd' : 'init scripts'), [seg, t.search], t.host)
    );
  }

  // ----- Docker -----

  renderDocker(panel, d) {
    if (!d.installed) {
      panel.replaceChildren(emptyState('layers', 'Docker is not installed', 'The docker command was not found on this server.'));
      return;
    }
    const ui = this.ui('docker');
    ui.containers ||= { sort: { key: 'name', dir: 1 } };
    ui.images ||= { sort: { key: 'repository', dir: 1 } };
    const running = d.containers.filter((c) => c.state === 'running').length;

    const containerCols = [
      {
        key: 'state',
        label: 'State',
        render: (c) =>
          h('span', { class: `badge ${c.state === 'running' ? 'green' : ['exited', 'dead', 'created'].includes(c.state) ? '' : 'amber'}` }, cap(c.state)),
      },
      { key: 'name', label: 'Name', class: 'mono nowrap' },
      { key: 'image', label: 'Image', class: 'mono muted nowrap' },
      { key: 'status', label: 'Status', class: 'muted nowrap' },
      { key: 'ports', label: 'Ports', class: 'truncate mono muted', title: (c) => c.ports, render: (c) => simplifyPorts(c.ports) },
      { key: 'actions', label: '', sortable: false, width: '1%', render: (c) => this.gateActions(this.containerActions(c), this.denyReason('docker')) },
    ];
    const ct = tableSection({
      ui: ui.containers,
      columns: containerCols,
      rows: d.containers,
      searchKeys: ['name', 'image', 'status'],
      placeholder: 'Search containers',
      empty: 'No containers',
    });
    ct.draw();

    const imageCols = [
      { key: 'repository', label: 'Repository', class: 'mono nowrap' },
      { key: 'tag', label: 'Tag', class: 'mono muted' },
      { key: 'id', label: 'Image ID', class: 'mono muted' },
      { key: 'size', label: 'Size', num: true, sortValue: (i) => parseSize(i.size) },
      { key: 'created', label: 'Created', class: 'muted nowrap' },
      {
        key: 'actions',
        label: '',
        sortable: false,
        width: '1%',
        render: (i) =>
          h(
            'div',
            { class: 'row-buttons' },
            this.gateActions(
              h('div', { class: 'row-buttons' }, h('button', { class: 'btn small', onclick: () => this.removeImage(i) }, icon('trash'), 'Remove')),
              this.denyReason('docker')
            ),
            this.noteButton('image', `${i.repository}:${i.tag}`, { target: 'image', id: i.id, label: `${i.repository}:${i.tag}` })
          ),
      },
    ];
    const it = tableSection({
      ui: ui.images,
      columns: imageCols,
      rows: d.images,
      searchKeys: ['repository', 'tag'],
      placeholder: 'Search images',
      empty: 'No images',
    });
    it.draw();

    const parts = [];
    if (d.error) parts.push(notice(d.error, 'error'));
    parts.push(
      section('Containers', [h('span', { class: 'count' }, d.containers.length), h('span', { class: 'hint' }, `${running} running`)], ct.search, ct.host)
    );
    if (d.compose.length) {
      const cols = [
        { key: 'name', label: 'Project', class: 'mono nowrap' },
        { key: 'status', label: 'Status', class: 'muted' },
        { key: 'config', label: 'Compose file', class: 'truncate mono muted', title: (p) => p.config },
        {
          key: 'actions',
          label: '',
          sortable: false,
          width: '1%',
          render: (p) => this.noteButton('compose', p.name, { target: 'compose', id: p.name, label: p.name }),
        },
      ];
      parts.push(section('Compose projects', h('span', { class: 'count' }, d.compose.length), null, dataTable({ columns: cols, rows: d.compose })));
    }
    parts.push(section('Images', h('span', { class: 'count' }, d.images.length), it.search, it.host));
    panel.replaceChildren(...parts);
  }

  // ----- Ports -----

  renderPorts(panel, d) {
    const ui = this.ui('ports');
    ui.sort ||= { key: 'port', dir: 1 };
    const groups = new Map();
    for (const p of d.list) {
      const protocol = p.protocol.replace(/6$/, '');
      const key = `${protocol}|${p.port}|${p.process}|${p.pid}`;
      if (!groups.has(key)) groups.set(key, { ...p, protocol, addresses: [] });
      const g = groups.get(key);
      if (!g.addresses.includes(p.address)) g.addresses.push(p.address);
    }
    const rows = [...groups.values()].map((g) => ({
      ...g,
      address: g.addresses.join(', '),
      exposure: g.addresses.some((a) => ['0.0.0.0', '::', '*', ''].includes(a))
        ? 'public'
        : g.addresses.every((a) => /^(127\.|::1$|localhost)/.test(a))
          ? 'local'
          : 'specific',
    }));
    const exposureBadge = {
      public: () => h('span', { class: 'badge amber', title: 'Reachable from other machines unless a firewall blocks it' }, 'All interfaces'),
      local: () => h('span', { class: 'badge green', title: 'Only reachable from the server itself' }, 'Localhost only'),
      specific: () => h('span', { class: 'badge blue' }, 'Specific address'),
    };
    const cols = [
      { key: 'port', label: 'Port', num: true, class: 'num mono', render: (r) => h('strong', {}, r.port) },
      { key: 'protocol', label: 'Protocol', render: (r) => h('span', { class: 'badge' }, r.protocol.toUpperCase()) },
      { key: 'exposure', label: 'Listening on', render: (r) => exposureBadge[r.exposure]() },
      { key: 'address', label: 'Address', class: 'mono muted' },
      { key: 'process', label: 'Program', class: 'mono', render: (r) => r.process || h('span', { class: 'muted' }, 'hidden') },
      { key: 'pid', label: 'PID', num: true, class: 'num mono muted' },
    ];
    const t = tableSection({
      ui,
      columns: cols,
      rows,
      searchKeys: ['port', 'process', 'address'],
      placeholder: 'Search ports or programs',
      empty: 'No listening ports found',
    });
    t.draw();
    panel.replaceChildren(
      d.limited ? notice('Some program names are hidden because they belong to other users. Connect as root to see all of them.') : '',
      section('Listening ports', h('span', { class: 'count' }, rows.length), t.search, t.host),
      this.firewallSection(d)
    );
  }

  // ----- Firewall -----

  firewallSection(d) {
    const fw = d.firewall || { tool: null, active: false, readable: true, rules: [] };
    // Remembered so the description fallback knows whether ufw stored the comment itself.
    this.portsFirewallTool = fw.tool;
    const openBtn = h('button', { class: 'btn primary', onclick: () => this.openPortDialog() }, icon('plus'), 'Open Port');
    const enableBtn = h('button', { class: 'btn', onclick: () => this.enableFirewall() }, icon('shield'), 'Turn On Firewall');
    const disableBtn = h('button', { class: 'btn', onclick: () => this.disableFirewall() }, icon('shield'), 'Turn Off Firewall');
    if (!fw.tool) {
      return section(
        'Firewall',
        null,
        null,
        h(
          'div',
          { class: 'card empty' },
          'No firewall (ufw or firewalld) is installed, so ports are only limited by your hosting provider. Install UFW from Installed Apps to manage ports here.'
        )
      );
    }
    if (!fw.readable) {
      return section('Firewall', null, openBtn, notice(`The ${fw.tool} rules can only be listed when connected as root or with sudo rights.`));
    }
    const cols = [
      { key: 'port', label: 'Port', num: true, class: 'num mono', render: (r) => h('strong', {}, r.endPort ? `${r.port}–${r.endPort}` : r.port) },
      { key: 'protocol', label: 'Protocol', render: (r) => h('span', { class: 'badge' }, r.protocol.toUpperCase()) },
      {
        key: 'action',
        label: 'Rule',
        render: (r) => h('span', { class: `badge ${r.action === 'ALLOW' ? 'green' : 'red'}` }, r.action === 'ALLOW' ? 'Open' : r.action.toLowerCase()),
      },
      {
        key: 'from',
        label: 'From',
        class: 'mono',
        // A limited rule is the safer one, so it is the one that stands out rather than the default.
        render: (r) =>
          r.sourceSpec
            ? h('span', { class: 'badge blue', title: `Only ${r.sourceSpec} can reach this port` }, r.sourceSpec)
            : h('span', { class: 'muted' }, 'Anywhere'),
      },
      {
        key: 'description',
        label: 'Description',
        class: 'muted',
        title: (r) => this.portDescription(r) || null,
        render: (r) => this.portDescription(r) || h('span', { class: 'muted' }, '—'),
      },
      {
        key: 'actions',
        label: '',
        width: '1%',
        // Ranges are left alone: editing or removing one needs the exact range rule, not a single port.
        render: (r) =>
          h(
            'div',
            { class: 'row-buttons' },
            r.endPort ? null : h('button', { class: 'btn small', onclick: () => this.openPortDialog(r) }, icon('edit'), 'Edit'),
            r.endPort ? null : h('button', { class: 'btn small', onclick: () => this.closePort(r) }, icon('x'), 'Close')
          ),
      },
    ];
    return section(
      'Firewall',
      fw.active ? h('span', { class: 'badge green' }, 'On') : h('span', { class: 'badge amber' }, 'Off'),
      h(
        'div',
        { class: 'row-buttons' },
        fw.tool === 'ufw' ? (fw.active ? disableBtn : enableBtn) : null,
        openBtn
      ),
      h(
        'div',
        {},
        fw.active ? null : notice(`The ${fw.tool} firewall is installed but switched off, so these rules are not enforced yet.`),
        fw.rules.length
          ? dataTable({ columns: cols, rows: fw.rules })
          : h('div', { class: 'card empty' }, 'No port rules yet. Click Open Port to allow one.')
      )
    );
  }

  async disableFirewall() {
    const ok = await confirmDialog({
      title: 'Turn off the firewall?',
      message: 'The server will accept connections on every port again. Your rules are kept and apply again when you switch the firewall back on.',
      confirmText: 'Turn Off Firewall',
      danger: true,
    });
    if (!ok) return;
    const done = await this.runJob(
      { kind: 'firewallDisable' },
      { title: 'Turning off the firewall', doneText: 'The firewall is off', after: null }
    );
    if (done) this.refreshTab('ports');
  }

  // Switching the firewall on blocks every port that isn't allowed, so the job allows SSH first.
  async enableFirewall() {
    const sshPort = this.server.port;
    const ok = await confirmDialog({
      title: 'Turn on the firewall?',
      message: `The server will then only accept the ports listed here, and block everything else. SSH on port ${sshPort} is allowed first, so this connection keeps working.`,
      confirmText: 'Turn On Firewall',
      danger: true,
    });
    if (!ok) return;
    const done = await this.runJob(
      { kind: 'firewallEnable', sshPort },
      { title: 'Turning on the firewall', doneText: 'The firewall is on', after: null }
    );
    if (done) this.refreshTab('ports');
  }

  // The description is stored by ufw itself as a rule comment. Firewalld has no such field, so for
  // that tool it is kept in the local notes store under a key built from the rule it belongs to.
  portNoteKey(rule) {
    return `${rule.port}/${rule.protocol}/${rule.sourceSpec || 'any'}`;
  }

  portDescription(rule) {
    if (rule.comment) return rule.comment;
    return this.notesIndex?.get(`port:${this.portNoteKey(rule)}`)?.title || '';
  }

  // Doubles as the edit form: given a rule it changes that rule's source and description, and shows
  // the port and protocol as fixed text, since changing those would be a different rule altogether.
  openPortDialog(rule = null) {
    const editing = Boolean(rule);
    const port = h('input', { class: 'input', type: 'number', placeholder: '8080', min: 1, max: 65535 });
    const sources = h('textarea', { class: 'input', rows: 2, placeholder: '203.0.113.4, 10.0.0.0/24' });
    const description = h('input', { class: 'input', type: 'text', placeholder: 'Staging API', maxlength: 120 });
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const protoOptions = h('div', { class: 'auth-options two' });
    const whoOptions = h('div', { class: 'auth-options two' });
    let protocol = editing ? rule.protocol : 'tcp';
    let who = editing && rule.sourceSpec ? 'list' : 'any';
    const wasDescription = editing ? this.portDescription(rule) : '';
    if (editing) {
      port.value = rule.port;
      sources.value = rule.sourceSpec;
      description.value = wasDescription;
    }
    const fail = (message) => {
      errorEl.replaceChildren(icon('alert'), h('div', {}, message));
      errorEl.hidden = false;
    };
    const drawProto = () => {
      protoOptions.replaceChildren(
        ...[
          ['tcp', 'TCP', 'Websites, APIs and most apps'],
          ['udp', 'UDP', 'DNS, VPN and game servers'],
        ].map(([id, title, desc]) =>
          h(
            'div',
            {
              class: `auth-option ${protocol === id ? 'active' : ''}`,
              onclick: () => {
                protocol = id;
                drawProto();
              },
            },
            h('strong', {}, title),
            h('span', {}, desc)
          )
        )
      );
    };
    const drawWho = () => {
      whoOptions.replaceChildren(
        ...[
          ['any', 'Anyone', 'Any machine on the internet'],
          ['list', 'Only these addresses', 'Just the IPs or ranges you list'],
        ].map(([id, title, desc]) =>
          h(
            'div',
            {
              class: `auth-option ${who === id ? 'active' : ''}`,
              onclick: () => {
                who = id;
                drawWho();
                sourceField.hidden = who !== 'list';
                if (who === 'list') sources.focus();
              },
            },
            h('strong', {}, title),
            h('span', {}, desc)
          )
        )
      );
    };
    const sourceField = h(
      'div',
      { class: 'field', hidden: true },
      h('label', {}, 'Allowed addresses'),
      sources,
      h('div', { class: 'help' }, 'One IP address or range per entry, separated by commas. At most 10.')
    );
    const go = async () => {
      errorEl.hidden = true;
      const number = Number(port.value);
      if (!Number.isInteger(number) || number < 1 || number > 65535) return fail('Enter a port between 1 and 65535.');
      const list = who === 'list' ? sources.value.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (who === 'list' && !list.length) return fail('Add at least one IP address or range, or choose Anyone.');
      if (list.length > MAX_PORT_SOURCES) return fail(`List at most ${MAX_PORT_SOURCES} addresses.`);
      const bad = list.find((entry) => !isAddress(entry));
      if (bad) return fail(`"${bad}" is not an IP address or range. Use a form like 203.0.113.4 or 10.0.0.0/24.`);
      const comment = description.value.trim();
      if (!RULE_COMMENT.test(comment)) return fail('The description must be one line, without quotes or backslashes.');
      const oldList = editing && rule.sourceSpec ? [rule.sourceSpec] : [];
      const sameSources = list.length === oldList.length && list.every((s, i) => s === oldList[i]);
      // Nothing to run when neither half of the rule actually moved.
      if (editing && sameSources && comment === wasDescription) return close();
      close();
      const where = list.length ? ` from ${list.join(', ')}` : '';
      const spec = editing
        ? { kind: 'firewallPortEdit', port: number, protocol, sources: list, comment, oldSources: oldList, sshPort: this.server.port }
        : { kind: 'firewallPort', action: 'open', port: number, protocol, sources: list, comment };
      const ok = await this.runQuickJob(spec, {
        busyText: `${editing ? 'Saving' : 'Opening'} port ${number}/${protocol}…`,
        doneText: `Port ${number}/${protocol} is open${where}`,
      });
      if (!ok) return;
      // Firewalld drops the description, so it is kept on this machine against the same rule key.
      if (this.portsFirewallTool !== 'ufw') {
        // The key follows the source, so an edit that moved it would otherwise strand the old note.
        if (editing) await api.notesDelete(this.server.id, 'port', this.portNoteKey(rule)).catch(() => {});
        if (comment) {
          for (const source of list.length ? list : ['']) {
            await api
              .notesSave(this.server.id, {
                kind: 'port',
                key: this.portNoteKey({ port: number, protocol, sourceSpec: source }),
                title: comment,
                body: '',
                onServer: false,
              })
              .catch(() => {});
          }
        }
      }
      this.refreshTab('ports');
    };
    drawProto();
    drawWho();
    const portField = editing
      ? h(
          'div',
          { class: 'field' },
          h('span', { class: 'label' }, 'Port'),
          h('div', {}, h('strong', { class: 'mono' }, String(rule.port)), ' ', h('span', { class: 'badge' }, rule.protocol.toUpperCase())),
          h('div', { class: 'help' }, 'To open a different port or protocol, close this rule and open a new one.')
        )
      : h('div', { class: 'field' }, h('label', {}, 'Port number'), port);
    const close = openModal({
      title: editing ? 'Edit Port Rule' : 'Open a Port',
      wide: true,
      body: h(
        'div',
        { class: 'form-stack' },
        errorEl,
        h(
          'p',
          {},
          editing
            ? 'Change who can reach this port and what the rule is for. The new rule is added before the old one is removed, so the port stays reachable.'
            : 'This lets other machines reach the port through the server firewall. A port only answers once a program on the server is listening on it.'
        ),
        portField,
        editing ? null : h('div', { class: 'field' }, h('span', { class: 'label' }, 'Protocol'), protoOptions),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Who can connect'), whoOptions),
        sourceField,
        h(
          'div',
          { class: 'field' },
          h('label', {}, 'Description'),
          description,
          h('div', { class: 'help' }, 'Optional. A short note on what this port is for, saved next to the rule on the server.')
        )
      ),
      footer: [
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => go() }, editing ? 'Save Changes' : 'Open Port'),
      ],
    });
    for (const field of [port, description]) {
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') go();
      });
    }
    sourceField.hidden = who !== 'list';
    setTimeout(() => (editing ? description : port).focus(), 30);
  }

  async closePort(rule) {
    const label = `${rule.port}/${rule.protocol}`;
    const where = rule.sourceSpec ? ` from ${rule.sourceSpec}` : '';
    const ok = await confirmDialog({
      title: `Close port ${label}${where}?`,
      message: rule.sourceSpec
        ? `The firewall will stop allowing ${rule.sourceSpec} to reach port ${label}. Other rules for this port stay as they are.`
        : `The firewall will stop allowing traffic to port ${label}. Anything that reaches this server on it from other machines will stop working.`,
      confirmText: 'Close Port',
      danger: true,
    });
    if (!ok) return;
    const done = await this.runQuickJob(
      {
        kind: 'firewallPort',
        action: 'close',
        port: rule.port,
        protocol: rule.protocol,
        sources: rule.sourceSpec ? [rule.sourceSpec] : [],
        sshPort: this.server.port,
      },
      { busyText: `Closing port ${label}…`, doneText: `Port ${label} is closed${where}` }
    );
    if (!done) return;
    await api.notesDelete(this.server.id, 'port', this.portNoteKey(rule)).catch(() => {});
    this.refreshTab('ports');
  }

  // ----- Users -----

  renderUsers(panel, d) {
    this.usersData = d;
    const people = d.users.filter((u) => !u.noLogin || u.isRoot);
    const badges = (u) => {
      const out = [];
      if (u.isRoot) out.push(h('span', { class: 'badge blue' }, 'You cannot change root here'));
      else if (u.locked) out.push(h('span', { class: 'badge red' }, 'Blocked'));
      else out.push(h('span', { class: 'badge green' }, 'Can sign in'));
      if (u.sudo && !u.isRoot) out.push(h('span', { class: 'badge amber', title: 'Can run commands as root' }, 'Admin'));
      if (u.docker) out.push(h('span', { class: 'badge amber', title: 'Docker access is effectively root access' }, 'Docker'));
      return h('div', { class: 'row-buttons' }, ...out);
    };
    const cols = [
      { key: 'name', label: 'User', class: 'mono nowrap', render: (u) => h('div', {}, h('div', { class: 'site-name' }, u.name), u.fullName ? h('div', { class: 'stat-detail' }, u.fullName) : null) },
      { key: 'state', label: '', sortable: false, render: badges },
      {
        key: 'keys',
        label: 'SSH keys',
        num: true,
        class: 'num',
        render: (u) => (d.limited ? h('span', { class: 'muted' }, '?') : h('span', {}, u.keys + (u.disabledKeys ? ` (+${u.disabledKeys} held)` : ''))),
      },
      { key: 'groups', label: 'Groups', class: 'truncate muted', title: (u) => u.groups.join('\n'), render: (u) => u.groups.join(', ') },
      { key: 'shell', label: 'Shell', class: 'mono muted nowrap' },
      { key: 'actions', label: '', sortable: false, width: '1%', render: (u) => this.gateActions(this.userActions(u), this.denyReason()) },
    ];
    const newBtn = h('button', { class: 'btn primary', onclick: () => this.openNewUser() }, icon('plus'), 'New User');
    const parts = [];
    const readOnly = this.denyReason();
    if (readOnly) parts.push(notice(readOnly));
    if (d.limited) parts.push(notice('Sign-in status and SSH keys can only be read as root, so those columns are incomplete.'));
    parts.push(section('People', h('span', { class: 'count' }, people.length), newBtn, dataTable({ columns: cols, rows: people, empty: 'No login accounts found' })));

    const sessions = d.sessions || [];
    const rootOnly = d.isRoot ? null : 'Only a connection signed in as root can sign other people out.';
    const sessionCols = [
      { key: 'user', label: 'User', class: 'mono nowrap' },
      { key: 'tty', label: 'Where', class: 'mono nowrap' },
      { key: 'host', label: 'From', render: (s) => s.host || h('span', { class: 'muted' }, 'local') },
      { key: 'since', label: 'Since', class: 'muted' },
      { key: 'actions', label: '', sortable: false, width: '1%', render: (s) => this.gateActions(this.sessionActions(s), rootOnly) },
    ];
    const refreshSessions = h('button', { class: 'btn', onclick: () => this.refreshTab('users') }, 'Refresh');
    parts.push(
      section(
        'Active sessions',
        h('span', { class: 'count' }, sessions.length),
        refreshSessions,
        dataTable({ columns: sessionCols, rows: sessions, empty: 'Nobody is signed in right now' })
      )
    );

    const withPassword = d.users.filter((u) => !u.isRoot && !u.locked).map((u) => u.name);
    parts.push(
      section(
        'Password sign-in',
        d.passwordAuth ? h('span', { class: 'badge amber' }, 'On') : h('span', { class: 'badge green' }, 'Keys only'),
        h('button', { class: 'btn', onclick: () => this.openPasswordAuth(withPassword) }, icon('key'), 'Choose who can use a password'),
        h(
          'div',
          { class: 'card empty' },
          d.passwordAuth
            ? 'Some users may sign in with a password. Root stays key-only.'
            : 'Everyone signs in with an SSH key. Turn this on per user if you need to hand someone a password instead.'
        )
      )
    );

    const groupCols = [
      { key: 'name', label: 'Group', class: 'mono nowrap' },
      { key: 'gid', label: 'ID', num: true, class: 'num mono muted' },
      { key: 'members', label: 'Members', class: 'truncate', render: (g) => g.members.join(', ') || h('span', { class: 'muted' }, 'Nobody yet') },
      {
        key: 'grants',
        label: 'Can do',
        sortable: false,
        render: (g) => {
          const out = [];
          if (g.admin) out.push(h('span', { class: 'badge amber', title: 'Members can run any command as root' }, 'Admin'));
          if (g.docker) out.push(h('span', { class: 'badge amber', title: 'Docker access is effectively admin' }, 'Docker'));
          if (g.services?.length) out.push(h('span', { class: 'badge blue', title: g.services.join('\n') }, `${g.services.length} service${g.services.length === 1 ? '' : 's'}`));
          return out.length ? h('div', { class: 'row-buttons' }, ...out) : h('span', { class: 'muted' }, 'Only what is shared with it');
        },
      },
    ];
    groupCols.push({
      key: 'actions',
      label: '',
      sortable: false,
      width: '1%',
      render: (g) =>
        h(
          'div',
          { class: 'row-buttons' },
          h('button', { class: 'btn small', title: `Manage ${g.name}`, onclick: () => this.openGroupMenu(g) }, icon('dots'), 'Settings')
        ),
    });
    const newGroupBtn = h('button', { class: 'btn primary', onclick: () => this.openNewGroup() }, icon('plus'), 'New Group');
    parts.push(section('Groups', h('span', { class: 'count' }, d.groups.length), newGroupBtn, dataTable({ columns: groupCols, rows: d.groups, empty: 'No groups' })));
    panel.replaceChildren(...parts);
  }

  userActions(u) {
    if (u.isRoot) return h('span', { class: 'muted' }, '—');
    const isMe = u.name === this.usersData?.me;
    return h(
      'div',
      { class: 'row-buttons' },
      h('button', { class: 'btn small', onclick: () => this.openUserKeys(u) }, icon('key'), 'SSH Key'),
      h('button', { class: 'btn small', onclick: () => this.openUserPassword(u) }, 'Password'),
      h('button', { class: 'btn small', onclick: () => this.toggleUserAccess(u) }, u.locked ? 'Allow' : 'Block'),
      isMe ? null : h('button', { class: 'btn small danger', onclick: () => this.deleteUser(u) }, 'Delete')
    );
  }

  sessionActions(s) {
    if (s.user === this.usersData?.me) return h('span', { class: 'muted' }, 'You');
    return h('div', { class: 'row-buttons' }, h('button', { class: 'btn small danger', onclick: () => this.disconnectSession(s) }, 'Disconnect'));
  }

  async disconnectSession(s) {
    const where = s.tty ? ` on ${s.tty}` : '';
    const ok = await confirmDialog({
      title: `Sign ${s.user} out?`,
      message: `${s.user}${where} will be disconnected right away. Anything they have not saved is lost.`,
      confirmText: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    if (await this.userJob({ kind: 'sessionLogout', tty: s.tty, id: s.id }, { title: `Signing ${s.user} out`, doneText: `${s.user} was signed out` })) {
      this.refreshTab('users');
    }
  }

  userJob(spec, options) {
    return this.runJob({ ...spec, me: this.usersData?.me || '' }, { after: null, ...options });
  }

  openNewUser() {
    const name = h('input', { class: 'input', placeholder: 'e.g. andi', spellcheck: false });
    const shell = h('select', { class: 'input' }, ...[['/bin/bash', 'Normal shell (bash)'], ['/bin/sh', 'Normal shell (sh)'], ['/usr/sbin/nologin', 'No shell (file transfer only)']].map(([v, l]) => h('option', { value: v }, l)));
    const chosen = new Set();
    const groupRows = (this.usersData?.groups || []).map((g) => {
      const box = h('input', { type: 'checkbox' });
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(g.name);
        else chosen.delete(g.name);
        syncCreate();
      });
      const marks = [];
      if (g.admin) marks.push(h('span', { class: 'badge amber', title: 'Members can run any command as root' }, 'Admin'));
      if (g.docker) marks.push(h('span', { class: 'badge amber', title: 'Docker access is effectively admin' }, 'Docker'));
      return h('label', { class: 'checkbox' }, box, g.name, ...marks);
    });
    const createBtn = h('button', { class: 'btn primary', onclick: () => create() }, 'Create User');
    // A server with no groups yet would otherwise leave the button stuck off for good.
    const syncCreate = () => {
      const missing = groupRows.length && !chosen.size;
      createBtn.disabled = missing;
      createBtn.title = missing ? 'Pick at least one group' : '';
    };
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const create = async () => {
      errorEl.hidden = true;
      const value = name.value.trim();
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value)) {
        errorEl.replaceChildren(icon('alert'), h('div', {}, 'Use lowercase letters, digits, - and _, starting with a letter.'));
        errorEl.hidden = false;
        return;
      }
      close();
      if (await this.userJob({ kind: 'userCreate', name: value, shell: shell.value, groups: [...chosen] }, { title: `Creating ${value}`, doneText: `${value} was created` })) {
        this.refreshTab('users');
      }
    };
    const close = openModal({
      title: 'New User',
      body: h(
        'div',
        { class: 'form-stack' },
        errorEl,
        h('p', {}, 'Creates a normal Linux account with its own home folder. Give them a password or an SSH key afterwards.'),
        h('div', { class: 'field' }, h('label', {}, 'Username'), name),
        h('div', { class: 'field' }, h('label', {}, 'Shell'), shell),
        h(
          'div',
          { class: 'field' },
          h('label', {}, 'Groups'),
          groupRows.length
            ? h('div', { class: 'form-stack' }, ...groupRows)
            : h('div', { class: 'help' }, 'No groups yet. You can make one in the Groups section and add them later.')
        )
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), createBtn],
    });
    syncCreate();
    setTimeout(() => name.focus(), 30);
  }

  openUserKeys(u) {
    const key = h('textarea', { class: 'input', rows: 4, spellcheck: false, style: { fontFamily: 'var(--mono)', minHeight: '90px' } });
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const addPasted = async () => {
      errorEl.hidden = true;
      const value = key.value.trim();
      if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)/.test(value)) {
        errorEl.replaceChildren(icon('alert'), h('div', {}, 'Paste the public key, which starts with ssh-ed25519 or ssh-rsa.'));
        errorEl.hidden = false;
        return;
      }
      close();
      if (await this.userJob({ kind: 'userAddKey', name: u.name, key: value }, { title: `Adding a key for ${u.name}`, doneText: `${u.name} can sign in with that key` })) {
        this.refreshTab('users');
      }
    };
    const generate = async () => {
      close();
      const busy = toast(`Creating a key pair for ${u.name}…`, { busy: true });
      let result;
      try {
        result = await api.usersGenerateKey(this.server.id, u.name);
      } catch (err) {
        busy.close();
        toast(err.message, { type: 'error' });
        return;
      }
      busy.close();
      if (!result.saved) {
        toast('No private key file was saved, so nothing was installed.', { type: 'error' });
        return;
      }
      if (await this.userJob({ kind: 'userAddKey', name: u.name, key: result.publicKey }, { title: `Adding the new key for ${u.name}`, doneText: `Saved to ${result.savedTo}` })) {
        this.refreshTab('users');
        toast(`Send ${result.savedTo} to ${u.name} over something private, then delete your copy.`);
      }
    };
    const close = openModal({
      title: `SSH access for ${u.name}`,
      wide: true,
      body: h(
        'div',
        { class: 'form-stack' },
        errorEl,
        h('p', {}, `${u.name} has ${u.keys} key${u.keys === 1 ? '' : 's'} installed.`),
        h('div', { class: 'field' }, h('label', {}, 'Paste the public key they sent you'), key, h('div', { class: 'help' }, 'One line, starting with ssh-ed25519 or ssh-rsa. This is the safe option: their private key never leaves their machine.')),
        h('div', { class: 'help' }, "Or create the pair here if they can't make one themselves. You then send them the private key file, which is only as safe as the way you send it.")
      ),
      footer: [
        h('button', { class: 'btn', onclick: () => generate() }, icon('plus'), 'Generate a Key Pair'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => addPasted() }, 'Add Key'),
      ],
    });
    setTimeout(() => key.focus(), 30);
  }

  openUserPassword(u) {
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'At least 8 characters' });
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const save = async () => {
      errorEl.hidden = true;
      if (pw.value.length < 8) {
        errorEl.replaceChildren(icon('alert'), h('div', {}, 'Use at least 8 characters.'));
        errorEl.hidden = false;
        return;
      }
      let tmp;
      try {
        tmp = await api.usersPasswordTemp(this.server.id, u.name, pw.value);
      } catch (err) {
        errorEl.replaceChildren(icon('alert'), h('div', {}, err.message));
        errorEl.hidden = false;
        return;
      }
      close();
      if (await this.userJob({ kind: 'userPassword', name: u.name, tmp }, { title: `Setting the password for ${u.name}`, doneText: `The password for ${u.name} was set` })) {
        this.refreshTab('users');
      }
    };
    const close = openModal({
      title: `Password for ${u.name}`,
      body: h(
        'div',
        { class: 'form-stack' },
        errorEl,
        h('div', { class: 'field' }, h('label', {}, 'New password'), pw, h('div', { class: 'help' }, "The password is sent through a private file on the server, never on a command line. They can only use it to sign in if password sign-in is switched on for them below.")
        )
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => save() }, 'Set Password')],
    });
    setTimeout(() => pw.focus(), 30);
  }

  async toggleUserAccess(u) {
    const blocking = !u.locked;
    const ok = await confirmDialog({
      title: blocking ? `Block ${u.name}?` : `Allow ${u.name} to sign in?`,
      message: blocking
        ? `${u.name} will not be able to sign in. Their password is disabled and their SSH keys are put aside, so this can be undone.`
        : `${u.name} will be able to sign in again, and any SSH keys that were put aside come back.`,
      confirmText: blocking ? 'Block' : 'Allow',
      danger: blocking,
    });
    if (!ok) return;
    if (await this.userJob({ kind: blocking ? 'userLock' : 'userUnlock', name: u.name }, { title: blocking ? `Blocking ${u.name}` : `Allowing ${u.name}`, doneText: blocking ? `${u.name} is blocked` : `${u.name} can sign in` })) {
      this.refreshTab('users');
    }
  }

  async deleteUser(u) {
    const removeHome = h('input', { type: 'checkbox' });
    const confirmed = await new Promise((resolve) => {
      let ok = false;
      const del = h('button', { class: 'btn danger solid', onclick: () => { ok = true; close(); } }, 'Delete User');
      const close = openModal({
        title: `Delete ${u.name}?`,
        body: h(
          'div',
          { class: 'form-stack' },
          h('p', {}, `The account ${u.name} will be permanently removed and can no longer sign in.`),
          h('label', { class: 'checkbox' }, removeHome, `Also delete the home folder (${u.home || '/home/' + u.name})`)
        ),
        footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), del],
        onClose: () => resolve(ok),
      });
      setTimeout(() => del.focus(), 30);
    });
    if (!confirmed) return;
    if (await this.userJob({ kind: 'userDelete', name: u.name, removeHome: removeHome.checked }, { title: `Deleting ${u.name}`, doneText: `${u.name} was deleted` })) {
      this.refreshTab('users');
    }
  }

  openPasswordAuth(candidates) {
    const d = this.usersData;
    const boxes = new Map();
    const rows = candidates.map((name) => {
      const box = h('input', { type: 'checkbox' });
      boxes.set(name, box);
      return h('label', { class: 'checkbox' }, box, name);
    });
    const save = async () => {
      const chosen = [...boxes.entries()].filter(([, b]) => b.checked).map(([n]) => n);
      close();
      if (await this.userJob({ kind: 'sshPasswordUsers', users: chosen }, { title: 'Updating SSH sign-in', doneText: chosen.length ? `Password sign-in allowed for ${chosen.join(', ')}` : 'Password sign-in switched off' })) {
        this.refreshTab('users');
      }
    };
    const close = openModal({
      title: 'Who may sign in with a password?',
      body: h(
        'div',
        { class: 'form-stack' },
        h('p', {}, 'Tick the users who should be able to sign in with a password as well as a key. Everyone else, including root, stays key-only.'),
        notice('A password can be guessed; an SSH key cannot. Only do this for people who cannot manage a key, and give them a long password.'),
        rows.length ? h('div', { class: 'form-stack' }, ...rows) : h('div', { class: 'card empty' }, 'There are no other users yet. Create one first.'),
        d?.permitRootLogin ? h('div', { class: 'help' }, `Root sign-in setting on this server: ${d.permitRootLogin}`) : null
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => save() }, 'Save')],
    });
  }

  // Browses /home and shares a folder with the group. Confined to /home on purpose: a recursive
  // chmod anywhere else would sooner or later land on system files or a running stack.
  // The group is where permissions live: one managed sudoers file per group, plus docker membership
  // kept in step for its members. Users get rights by being in a group, never individually here.
  // Five buttons per row crowded the table, so the actions moved into one sheet. Each item closes
  // this sheet before opening its own: they are modals too, and a stale one underneath would linger.
  openGroupMenu(group) {
    const item = (name, label, fn, extra) =>
      h(
        'button',
        {
          class: `btn ${extra || ''}`.trim(),
          onclick: () => {
            close();
            fn.call(this, group);
          },
        },
        icon(name),
        label
      );
    const close = openModal({
      title: `Manage ${group.name}`,
      body: h(
        'div',
        { class: 'form-stack action-menu' },
        item('users', 'Members', this.openGroupMembers),
        item('shield', 'Permissions', this.openGroupPermissions),
        item('edit', 'Rename', this.renameGroup),
        item('folder', 'Folders', this.openGroupFolders),
        item('trash', 'Delete', this.deleteGroup, 'danger')
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel')],
    });
  }

  async renameGroup(group) {
    const res = await promptDialog({
      title: `Rename ${group.name}`,
      message: 'Folders owned by this group follow the new name automatically, and its permissions are kept.',
      label: 'New group name',
      value: group.name,
      confirmText: 'Rename',
    });
    if (!res || !res.value || res.value.trim() === group.name) return;
    const next = res.value.trim();
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(next)) {
      toast('Use lowercase letters, digits, - and _, starting with a letter.', { type: 'error' });
      return;
    }
    if (await this.userJob({ kind: 'groupRename', name: group.name, newName: next }, { title: `Renaming ${group.name}`, doneText: `${group.name} is now called ${next}` })) {
      this.refreshTab('users');
    }
  }

  openGroupPermissions(group) {
    const admin = h('input', { type: 'checkbox', checked: Boolean(group.admin) });
    const docker = h('input', { type: 'checkbox', checked: Boolean(group.docker) });
    const serviceBox = h('div', { class: 'form-stack' }, h('div', { class: 'help' }, 'Loading services…'));
    const chosen = new Set(group.services || []);
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const wasAdmin = Boolean(group.admin);
    const wasDocker = Boolean(group.docker);

    const drawServices = (list) => {
      const rows = list.map((name) => {
        const box = h('input', { type: 'checkbox', checked: chosen.has(name) });
        box.addEventListener('change', () => (box.checked ? chosen.add(name) : chosen.delete(name)));
        return h('label', { class: 'checkbox' }, box, name);
      });
      serviceBox.replaceChildren(
        h('div', { class: 'help' }, 'Members can start, stop, restart and check just these, without any other root rights.'),
        ...(rows.length ? rows : [h('div', { class: 'card empty' }, 'No services found.')])
      );
    };
    api
      .services(this.server.id)
      .then((d) => drawServices([...new Set([...chosen, ...d.list.filter((x) => x.sub === 'running').map((x) => x.name)])].slice(0, 40)))
      .catch(() => drawServices([...chosen]));

    const save = async () => {
      errorEl.hidden = true;
      close();
      const services = [...chosen];
      // Admin, Docker and the service list are one setting now, saved together and read back together.
      const unchanged =
        admin.checked === wasAdmin && docker.checked === wasDocker && services.join(',') === (group.services || []).join(',');
      if (unchanged) return;
      await this.userJob(
        { kind: 'groupPermissions', name: group.name, admin: admin.checked, docker: docker.checked, services, members: group.members },
        { title: `Updating what ${group.name} may do`, doneText: `Permissions for ${group.name} were saved` }
      );
      this.refreshTab('users');
    };

    const close = openModal({
      title: `What ${group.name} may do`,
      wide: true,
      body: h(
        'div',
        { class: 'form-stack' },
        errorEl,
        h('p', {}, `Everyone in ${group.name} gets whatever is switched on here. Add or remove people with the Members button, and share folders with the Folders button.`),
        h('label', { class: 'checkbox' }, admin, 'Admin: run any command as root'),
        notice('Admin undoes every other limit here, including your own. Leave it off for people who only need to work in their folders.'),
        h('label', { class: 'checkbox' }, docker, 'Use Docker'),
        h('div', { class: 'help' }, 'Docker access lets a member start a container that reads the whole disk, so it is admin rights by another route.'),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Services this group may control'), serviceBox)
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => save() }, 'Save')],
    });
  }

  openGroupFolders(group) {
    const listEl = h('div');
    const crumbEl = h('div', { class: 'help' });
    let path = '/home';
    const draw = async () => {
      crumbEl.textContent = path;
      listEl.replaceChildren(loadingEl('Reading folders…'));
      let res;
      try {
        res = await api.listDir(this.server.id, path);
      } catch (err) {
        listEl.replaceChildren(notice(err.message, 'error'));
        return;
      }
      const dirs = res.entries.filter((e) => e.isDir && !e.name.startsWith('.'));
      const rows = dirs.map((e) => {
        const shared = e.group === group.name;
        return h(
          'div',
          { class: 'ai-row', style: { justifyContent: 'space-between', padding: '6px 0' } },
          h('button', { class: 'btn small', title: 'Open this folder', onclick: () => { path = e.path; draw(); } }, icon('folder'), e.name),
          h(
            'div',
            { class: 'row-buttons' },
            h('span', { class: `badge ${shared ? 'green' : ''}` }, shared ? `Shared with ${group.name}` : `Group: ${e.group}`),
            h('button', { class: `btn small ${shared ? '' : 'primary'}`, onclick: () => apply(e.path, !shared) }, shared ? 'Stop sharing' : 'Share')
          )
        );
      });
      listEl.replaceChildren(
        path === '/home'
          ? null
          : h('button', { class: 'btn small', onclick: () => { path = parentPath(path) || '/home'; draw(); } }, icon('arrowUp'), 'Up'),
        h(
          'div',
          { class: 'row-buttons', style: { justifyContent: 'space-between', padding: '6px 0' } },
          h('strong', {}, path),
          h('button', { class: 'btn small primary', onclick: () => apply(path, true) }, `Share this folder with ${group.name}`)
        ),
        ...(rows.length ? rows : [h('div', { class: 'card empty' }, 'No folders here.')])
      );
    };
    const apply = async (target, grant) => {
      close();
      const done = await this.userJob(
        { kind: 'groupFolder', name: group.name, path: target, action: grant ? 'grant' : 'revoke' },
        {
          title: grant ? `Sharing ${target} with ${group.name}` : `Removing ${group.name} from ${target}`,
          doneText: grant ? `${group.name} can work in ${target}` : `${group.name} can no longer write ${target}`,
        }
      );
      if (done) this.refreshTab('users');
    };
    draw();
    const close = openModal({
      title: `Folders for ${group.name}`,
      wide: true,
      body: h(
        'div',
        { class: 'form-stack' },
        h('p', {}, `Pick a folder under /home that everyone in ${group.name} should be able to read and write. Sharing a folder covers everything inside it, and anything added later.`),
        notice('Only /home can be shared this way. Folders elsewhere, such as your apps in /root, are left alone.'),
        crumbEl,
        listEl
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Close')],
    });
  }

  openNewGroup() {
    const name = h('input', { class: 'input', placeholder: 'e.g. web-team', spellcheck: false });
    const errorEl = h('div', { class: 'notice error', hidden: true });
    const create = async () => {
      errorEl.hidden = true;
      const value = name.value.trim();
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value)) {
        errorEl.replaceChildren(icon('alert'), h('div', {}, 'Use lowercase letters, digits, - and _, starting with a letter.'));
        errorEl.hidden = false;
        return;
      }
      close();
      if (await this.userJob({ kind: 'groupCreate', name: value }, { title: `Creating the group ${value}`, doneText: `The group ${value} was created` })) {
        this.refreshTab('users');
      }
    };
    const close = openModal({
      title: 'New Group',
      body: h(
        'div',
        { class: 'form-stack' },
        errorEl,
        h('p', {}, 'A group is a label you can put on several users at once, so folders and permissions can be given to all of them together.'),
        h('div', { class: 'field' }, h('label', {}, 'Group name'), name)
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => create() }, 'Create Group')],
    });
    setTimeout(() => name.focus(), 30);
  }

  openGroupMembers(group) {
    const d = this.usersData;
    const me = d?.me || '';
    const boxes = new Map();
    const rows = (d?.users || []).map((u) => {
      const isMember = group.members.includes(u.name);
      const fixed = u.isRoot || u.name === me;
      const box = h('input', { type: 'checkbox', checked: isMember, disabled: fixed });
      boxes.set(u.name, { box, was: isMember });
      return h('label', { class: 'checkbox' }, box, u.name, fixed ? h('span', { class: 'muted' }, ' (cannot be changed here)') : null);
    });
    const save = async () => {
      const add = [];
      const remove = [];
      for (const [name, { box, was }] of boxes) {
        if (box.disabled) continue;
        if (box.checked && !was) add.push(name);
        if (!box.checked && was) remove.push(name);
      }
      close();
      if (!add.length && !remove.length) return;
      if (await this.userJob({ kind: 'groupMembers', name: group.name, add, remove }, { title: `Updating ${group.name}`, doneText: `Who is in ${group.name} was updated` })) {
        this.refreshTab('users');
      }
    };
    const rootLike = ['sudo', 'wheel', 'admin', 'docker'].includes(group.name);
    const close = openModal({
      title: `Who is in ${group.name}?`,
      body: h(
        'div',
        { class: 'form-stack' },
        rootLike
          ? notice(
              group.name === 'docker'
                ? 'Anyone in the docker group can start a container that reads the whole disk, so this is the same as giving them full control of the server.'
                : `Anyone in ${group.name} can run commands as root. Only add people you trust with the whole server.`
            )
          : null,
        rows.length ? h('div', { class: 'form-stack' }, ...rows) : h('div', { class: 'card empty' }, 'There are no users yet.'),
        h('div', { class: 'help' }, 'Root and the account you are signed in with are left alone on purpose, so you cannot lock yourself out.')
      ),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => save() }, 'Save')],
    });
  }

  async deleteGroup(group) {
    const ok = await confirmDialog({
      title: `Delete the group ${group.name}?`,
      message: group.members.length
        ? `${group.members.join(', ')} will no longer be in this group. The users themselves stay, and so do their files.`
        : 'The users themselves stay, and so do their files.',
      confirmText: 'Delete Group',
      danger: true,
    });
    if (!ok) return;
    if (await this.userJob({ kind: 'groupDelete', name: group.name }, { title: `Deleting ${group.name}`, doneText: `The group ${group.name} was deleted` })) {
      this.refreshTab('users');
    }
  }

  // ----- Processes -----

  renderProcesses(panel, d) {
    const ui = this.ui('processes');
    ui.sort ||= { key: 'cpu', dir: -1 };
    const cols = [
      { key: 'pid', label: 'PID', num: true, class: 'num mono muted' },
      { key: 'user', label: 'User', class: 'nowrap' },
      { key: 'cpu', label: 'CPU %', num: true, render: (r) => r.cpu.toFixed(1) },
      { key: 'mem', label: 'Mem %', num: true, render: (r) => r.mem.toFixed(1) },
      { key: 'rss', label: 'Memory', num: true, render: (r) => fmtBytes(r.rss) },
      {
        key: 'elapsed',
        label: 'Running for',
        class: 'muted nowrap',
        sortValue: (r) => elapsedSeconds(r.elapsed),
        render: (r) => fmtDuration(elapsedSeconds(r.elapsed)),
      },
      { key: 'name', label: 'Name', class: 'mono nowrap' },
      { key: 'command', label: 'Command', class: 'truncate mono muted', title: (r) => r.command },
    ];
    const count = h('span', { class: 'count' }, d.list.length);
    const t = tableSection({
      ui,
      columns: cols,
      rows: d.list,
      searchKeys: ['name', 'command', 'user', 'pid'],
      placeholder: 'Search processes',
      empty: 'No processes',
      onCount: (n) => (count.textContent = n),
    });
    t.draw();
    const auto = h(
      'label',
      { class: 'checkbox' },
      h('input', {
        type: 'checkbox',
        checked: !!ui.auto,
        onchange: (e) => {
          ui.auto = e.target.checked;
          if (ui.auto) this.startAutoRefresh();
          else this.stopAutoRefresh();
        },
      }),
      'Auto-refresh'
    );
    panel.replaceChildren(section('Processes', [count, h('span', { class: 'hint' }, 'Top 300 by CPU')], [auto, t.search], t.host));
  }

  startAutoRefresh() {
    this.stopAutoRefresh();
    this.autoTimer = setInterval(() => {
      if (this.tab !== 'processes' || this.status !== 'connected' || state.selectedId !== this.server.id || document.hidden) return;
      this.load('processes', () => api.processes(this.server.id), (p, d) => this.renderProcesses(p, d), '', { quiet: true });
    }, 5000);
  }

  stopAutoRefresh() {
    clearInterval(this.autoTimer);
    this.autoTimer = null;
    if (this.uiState.processes) this.uiState.processes.auto = false;
  }

  // ----- Files -----

  async initFiles() {
    const panel = this.panels.files;
    panel.classList.add('flush');
    const f = (this.files = { path: null, home: null, back: [], entries: [], showHidden: false, filter: '', sort: { key: 'name', dir: 1 }, selected: null, token: 0 });
    const E = (this.fileEls = {
      back: h('button', { class: 'icon-btn', title: 'Back', disabled: true, onclick: () => this.goBack() }, icon('arrowLeft')),
      up: h('button', { class: 'icon-btn', title: 'Parent folder', onclick: () => f.path && this.navigate(parentPath(f.path)) }, icon('arrowUp')),
      home: h('button', { class: 'icon-btn', title: 'Home folder', onclick: () => f.home && this.navigate(f.home) }, icon('home')),
      crumbs: h('div', {
        class: 'breadcrumb',
        title: 'Click empty space to type a path',
        onclick: (e) => {
          if (e.target === E.crumbs) this.editPath();
        },
      }),
      hidden: h(
        'button',
        {
          class: 'icon-btn',
          title: 'Show hidden files',
          onclick: () => {
            f.showHidden = !f.showHidden;
            E.hidden.classList.toggle('active', f.showHidden);
            this.drawFiles();
          },
        },
        icon('eye')
      ),
      body: h('div', { class: 'files-body' }),
      status: h('div', { class: 'files-status' }),
    });

    const toolbar = h(
      'div',
      { class: 'files-toolbar' },
      E.back,
      E.up,
      E.home,
      E.crumbs,
      searchInput('Filter this folder', '', (v) => {
        f.filter = v;
        this.drawFiles();
      }),
      E.hidden,
      h('button', { class: 'icon-btn', title: 'New file', onclick: () => this.newFile() }, icon('filePlus')),
      h('button', { class: 'icon-btn', title: 'New folder', onclick: () => this.newFolder() }, icon('folderPlus')),
      h('button', { class: 'icon-btn', title: 'Upload files', onclick: () => this.uploadFiles() }, icon('upload')),
      h('button', { class: 'icon-btn', title: 'Open terminal in this folder', onclick: () => f.path && this.openTerminalAt(f.path) }, icon('terminal')),
      h('button', { class: 'icon-btn', title: 'Refresh', onclick: () => f.path && this.navigate(f.path, false) }, icon('refresh'))
    );

    const wrap = h('div', { class: 'files-wrap' }, E.body, h('div', { class: 'drop-overlay' }, 'Drop files to upload to this folder'));
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    wrap.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      wrap.classList.add('dragging');
    });
    wrap.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    wrap.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) wrap.classList.remove('dragging');
    });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      wrap.classList.remove('dragging');
      if (e.dataTransfer.files.length && f.path) this.uploadDropped([...e.dataTransfer.files]);
    });

    panel.replaceChildren(toolbar, wrap, E.status);
    E.body.replaceChildren(loadingEl());
    try {
      f.home = await api.home(this.server.id);
      await this.navigate(f.home, false);
    } catch (err) {
      E.body.replaceChildren(
        errorState(err.message, () => {
          this.loaded.delete('files');
          this.showTab('files');
        })
      );
    }
  }

  async navigate(dir, pushHistory = true) {
    const f = this.files;
    const E = this.fileEls;
    if (!f) return;
    if (dir === '~' || dir.startsWith('~/')) dir = f.home + dir.slice(1);
    const token = ++f.token;
    const slow = setTimeout(() => {
      if (f.token === token) E.body.replaceChildren(loadingEl());
    }, 300);
    try {
      const res = await api.listDir(this.server.id, dir);
      if (f.token !== token) return;
      const changed = res.path !== f.path;
      if (pushHistory && f.path && changed) f.back.push(f.path);
      f.path = res.path;
      f.entries = res.entries;
      if (changed) f.selected = null;
      E.back.disabled = !f.back.length;
      E.up.disabled = f.path === '/';
      this.drawCrumbs();
      this.drawFiles();
      if (changed) E.body.scrollTop = 0;
    } catch (err) {
      if (f.token !== token) return;
      toast(`Cannot open ${dir}: ${err.message}`, { type: 'error' });
      if (f.path) this.drawFiles();
      else E.body.replaceChildren(errorState(err.message));
    } finally {
      clearTimeout(slow);
    }
  }

  goBack() {
    const prev = this.files.back.pop();
    if (prev) this.navigate(prev, false);
  }

  drawCrumbs() {
    const E = this.fileEls;
    const parts = this.files.path.split('/').filter(Boolean);
    const nodes = [h('button', { class: 'crumb', onclick: () => this.navigate('/') }, '/')];
    parts.forEach((part, i) => {
      const target = `/${parts.slice(0, i + 1).join('/')}`;
      if (i > 0) nodes.push(icon('chevronRight', 'sep'));
      nodes.push(h('button', { class: 'crumb', onclick: () => this.navigate(target) }, part));
    });
    E.crumbs.replaceChildren(...nodes);
    E.crumbs.scrollLeft = E.crumbs.scrollWidth;
  }

  editPath() {
    const E = this.fileEls;
    const input = h('input', { class: 'input', value: this.files.path, spellcheck: false });
    let finished = false;
    const finish = (go) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      this.drawCrumbs();
      if (go && value) this.navigate(value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(false));
    E.crumbs.replaceChildren(input);
    input.focus();
    input.select();
  }

  drawFiles() {
    const f = this.files;
    const E = this.fileEls;
    const q = f.filter.trim().toLowerCase();
    const visible = f.entries.filter((e) => (f.showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
    const hiddenCount = f.showHidden ? 0 : f.entries.filter((e) => e.name.startsWith('.')).length;

    const cols = [
      {
        key: 'name',
        label: 'Name',
        render: (e) =>
          h(
            'div',
            { class: 'file-name' },
            icon(e.isDir ? 'folder' : e.isLink ? 'link' : 'file', e.isDir ? 'dir' : e.isLink ? 'lnk' : ''),
            h('span', { class: 'label' }, e.name),
            e.isLink ? h('span', { class: 'link-target' }, e.broken ? '(broken link)' : '(link)') : null
          ),
      },
      { key: 'size', label: 'Size', num: true, sortValue: (e) => (e.isDir ? -1 : e.size), render: (e) => (e.isDir ? '—' : fmtBytes(e.size)) },
      { key: 'mtime', label: 'Modified', class: 'nowrap muted', render: (e) => fmtDate(e.mtime) },
      { key: 'perms', label: 'Permissions', class: 'mono muted' },
      { key: 'owner', label: 'Owner', class: 'nowrap muted', render: (e) => (e.group && e.group !== e.owner ? `${e.owner}:${e.group}` : e.owner) },
      { key: 'actions', label: '', sortable: false, width: '150px', render: (e) => this.fileActions(e) },
    ];
    // Folders first; Array#sort is stable, so the column order is kept inside each group.
    const rows = sortRows(visible, cols, f.sort).sort((a, b) => b.isDir - a.isDir);

    E.body.replaceChildren(
      dataTable({
        columns: cols,
        rows,
        sort: f.sort,
        empty: q ? 'No matching files' : 'This folder is empty',
        onSort: (key) => {
          f.sort = f.sort.key === key ? { key, dir: -f.sort.dir } : { key, dir: 1 };
          this.drawFiles();
        },
        rowProps: (e) => ({
          class: f.selected === e.path ? 'selected' : '',
          onclick: (ev) => {
            f.selected = e.path;
            E.body.querySelectorAll('tr.selected').forEach((tr) => tr.classList.remove('selected'));
            ev.currentTarget.classList.add('selected');
          },
          ondblclick: () => this.openEntry(e),
        }),
      })
    );

    const dirs = visible.filter((e) => e.isDir).length;
    const files = visible.length - dirs;
    E.status.replaceChildren(
      h(
        'span',
        {},
        `${dirs} folder${dirs === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}`,
        hiddenCount ? ` · ${hiddenCount} hidden` : ''
      ),
      h('span', { class: 'mono' }, f.path)
    );
  }

  fileActions(e) {
    const btn = (name, title, fn) =>
      h(
        'button',
        {
          class: 'icon-btn',
          title,
          onclick: (ev) => {
            ev.stopPropagation();
            fn();
          },
          ondblclick: (ev) => ev.stopPropagation(),
        },
        icon(name)
      );
    return h(
      'div',
      { class: 'row-actions' },
      e.isDir ? btn('terminal', 'Open terminal here', () => this.openTerminalAt(e.path)) : btn('eye', 'Preview', () => this.previewFile(e)),
      e.isDir ? null : btn('code', 'Edit', () => this.openEditor(e.path)),
      btn('download', e.isDir ? 'Download folder as .tar.gz' : 'Download', () => this.downloadEntry(e)),
      btn('edit', 'Rename', () => this.renameEntry(e)),
      btn('trash', 'Delete', () => this.deleteEntry(e))
    );
  }

  openEntry(e) {
    if (e.isDir) this.navigate(e.path);
    else if (!e.broken) this.previewFile(e);
  }

  async previewFile(e) {
    const body = h('div', { style: { height: '100%' } }, loadingEl('Opening file…'));
    const close = openModal({
      title: e.name,
      subtitle: `${e.path} · ${fmtBytes(e.size)}`,
      body,
      wide: true,
      footer: [
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              close();
              this.openEditor(e.path);
            },
          },
          icon('code'),
          'Edit'
        ),
        h('button', { class: 'btn', onclick: () => this.downloadEntry(e) }, icon('download'), 'Download'),
        h('button', { class: 'btn primary', onclick: () => close() }, 'Close'),
      ],
    });
    try {
      const res = await api.readText(this.server.id, e.path);
      if (res.tooLarge) body.replaceChildren(emptyState('file', 'Too large to preview', `This file is ${fmtBytes(res.size)}. Download it to open it on your PC.`));
      else if (res.binary) body.replaceChildren(emptyState('file', 'Not a text file', 'This file is binary. Download it to open it on your PC.'));
      else body.replaceChildren(h('pre', { class: 'preview' }, res.text || '(empty file)'));
    } catch (err) {
      body.replaceChildren(emptyState('alert', 'Cannot open this file', err.message));
    }
  }

  async downloadEntry(e) {
    let busy;
    try {
      const pending = api.download(this.server.id, e.path, e.isDir);
      busy = toast(`Downloading ${e.name}…`, { busy: true });
      const saved = await pending;
      busy.close();
      if (saved) toast(`Downloaded ${e.name}`, { type: 'success', action: { label: 'Show in File Explorer', run: () => api.showInFolder(saved) } });
    } catch (err) {
      busy?.close();
      toast(`Download failed: ${err.message}`, { type: 'error' });
    }
  }

  async renameEntry(e) {
    const res = await promptDialog({ title: `Rename ${e.isDir ? 'folder' : 'file'}`, label: 'New name', value: e.name, confirmText: 'Rename' });
    const name = res?.value.trim();
    if (!name || name === e.name) return;
    if (name.includes('/')) {
      toast('A name cannot contain "/"', { type: 'error' });
      return;
    }
    try {
      await api.rename(this.server.id, e.path, joinPath(parentPath(e.path), name));
      this.navigate(this.files.path, false);
    } catch (err) {
      toast(`Rename failed: ${err.message}`, { type: 'error' });
    }
  }

  async deleteEntry(e) {
    const ok = await confirmDialog({
      title: `Delete ${e.isDir && !e.isLink ? 'folder' : 'file'} "${e.name}"?`,
      message: e.isDir && !e.isLink
        ? `The folder ${e.path} and everything inside it will be permanently deleted from the server. This cannot be undone.`
        : `${e.path} will be permanently deleted from the server. This cannot be undone.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      // Symlinks are removed as links (never following them into the target folder).
      await api.remove(this.server.id, e.path, e.isDir && !e.isLink);
      toast(`Deleted ${e.name}`, { type: 'success' });
      this.navigate(this.files.path, false);
    } catch (err) {
      toast(`Delete failed: ${err.message}`, { type: 'error' });
    }
  }

  async newFile() {
    const res = await promptDialog({ title: 'New file', label: `Create inside ${this.files.path}`, confirmText: 'Create' });
    const name = res?.value.trim();
    if (!name) return;
    if (name.includes('/')) {
      toast('A name cannot contain "/"', { type: 'error' });
      return;
    }
    const exists = this.files.entries.some((e) => e.name === name);
    this.openEditor(joinPath(this.files.path, name), { isNew: !exists });
  }

  // Text editor. Files the login user can't write (like /etc/nginx configs) are saved with sudo.
  async openEditor(path, { isNew = false } = {}) {
    const name = path.split('/').pop();
    let original = '';
    if (!isNew) {
      try {
        const res = await api.readText(this.server.id, path);
        if (res.tooLarge) {
          toast(`${name} is too large to edit here (${fmtBytes(res.size)}).`, { type: 'error' });
          return;
        }
        if (res.binary) {
          toast(`${name} is not a text file, so it can't be edited here.`, { type: 'error' });
          return;
        }
        original = res.text;
      } catch (err) {
        toast(`Cannot open ${name}: ${err.message}`, { type: 'error' });
        return;
      }
    }

    let saved = original;
    let exists = !isNew;
    let saving = false;
    const editor = h('textarea', { class: 'editor', spellcheck: false, wrap: 'off', value: original });
    const stateEl = h('span', { class: 'editor-state' });
    const saveBtn = h('button', { class: 'btn primary', onclick: () => save() }, 'Save');
    const dirty = () => editor.value !== saved;
    const updateState = () => {
      stateEl.textContent = saving ? 'Saving…' : dirty() ? 'Unsaved changes' : exists ? 'No unsaved changes' : 'New file, not saved yet';
      saveBtn.disabled = saving || (exists && !dirty());
    };

    const save = async () => {
      if (saving) return false;
      saving = true;
      updateState();
      const text = editor.value;
      try {
        try {
          await api.writeText(this.server.id, path, text);
        } catch (err) {
          if (!/permission denied/i.test(err.message)) throw err;
          const tmp = await api.writeTemp(this.server.id, text);
          const ok = await this.runQuickJob({ kind: 'writeFile', tmp, target: path }, { busyText: `Saving ${name} with administrator rights…` });
          if (!ok) {
            api.remove(this.server.id, tmp, false).catch(() => {});
            return false;
          }
        }
        saved = text;
        exists = true;
        toast(`Saved ${name}`, { type: 'success' });
        if (this.files?.path === parentPath(path)) this.navigate(this.files.path, false);
        return true;
      } catch (err) {
        toast(`Could not save ${name}: ${err.message}`, { type: 'error' });
        return false;
      } finally {
        saving = false;
        updateState();
      }
    };

    const footer = [stateEl, h('div', { class: 'spacer' })];
    if (path.startsWith('/etc/nginx/')) {
      footer.push(
        h(
          'button',
          {
            class: 'btn',
            title: 'Check the Nginx config for mistakes, then apply it',
            onclick: async () => {
              if (dirty() && !(await save())) return;
              this.testReloadNginx();
            },
          },
          icon('refresh'),
          'Test & Apply'
        )
      );
    }
    footer.push(h('button', { class: 'btn', onclick: () => close() }, 'Close'), saveBtn);
    const close = openModal({
      title: name,
      subtitle: path,
      body: editor,
      footer,
      wide: true,
      canClose: () => !saving && (!dirty() || window.confirm('Close without saving your changes?')),
    });
    editor.addEventListener('input', updateState);
    editor.addEventListener('keydown', (e) => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      } else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '    ');
      }
    });
    updateState();
    setTimeout(() => editor.focus(), 30);
  }

  testReloadNginx() {
    return this.runQuickJob({ kind: 'nginxReload' }, { busyText: 'Checking the Nginx config…', doneText: 'Nginx config is valid and has been applied' });
  }

  async newFolder() {
    const res = await promptDialog({ title: 'New folder', label: `Create inside ${this.files.path}`, confirmText: 'Create' });
    const name = res?.value.trim();
    if (!name) return;
    try {
      await api.mkdir(this.server.id, joinPath(this.files.path, name));
      this.navigate(this.files.path, false);
    } catch (err) {
      toast(`Could not create folder: ${err.message}`, { type: 'error' });
    }
  }

  async uploadFiles() {
    const dir = this.files.path;
    try {
      const pending = api.upload(this.server.id, dir);
      const res = await pending;
      this.reportUpload(res, dir);
    } catch (err) {
      toast(`Upload failed: ${err.message}`, { type: 'error' });
    }
  }

  async uploadDropped(files) {
    const dir = this.files.path;
    const busy = toast(`Uploading ${files.length} item${files.length === 1 ? '' : 's'}…`, { busy: true });
    try {
      const res = await api.uploadDropped(this.server.id, dir, files);
      busy.close();
      this.reportUpload(res, dir);
    } catch (err) {
      busy.close();
      toast(`Upload failed: ${err.message}`, { type: 'error' });
    }
  }

  reportUpload({ uploaded, skipped }, dir) {
    if (uploaded.length) toast(`Uploaded ${uploaded.length === 1 ? uploaded[0] : `${uploaded.length} files`} to ${dir}`, { type: 'success' });
    if (skipped.length) toast(`Skipped ${skipped.join(', ')}: only files can be uploaded, not folders.`, { type: 'error' });
    if (this.files?.path === dir) this.navigate(dir, false);
  }

  // ----- Terminal -----

  async initTerminal() {
    const panel = this.panels.terminal;
    panel.classList.add('flush');
    this.teardownTerminal();
    const hostEl = h('div', { class: 'terminal-host' });
    panel.replaceChildren(hostEl);

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#1b1b1d', foreground: '#e8e8ea', cursor: '#0a84ff', selectionBackground: 'rgba(10,132,255,0.35)' },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(hostEl);
    this.term = term;
    this.fit = fit;
    this.fitTerminal();

    try {
      const termId = await api.openTerminal(this.server.id, term.cols, term.rows);
      if (this.term !== term) {
        api.closeTerminal(termId);
        return;
      }
      this.termId = termId;
      terminals.set(termId, this);
      term.onData((data) => api.writeTerminal(termId, data));
      term.onResize(({ cols, rows }) => api.resizeTerminal(termId, cols, rows));
      this.resizeObserver = new ResizeObserver(() => this.fitTerminal());
      this.resizeObserver.observe(hostEl);
      if (this.pendingCd) {
        api.writeTerminal(termId, `cd ${shellQuote(this.pendingCd)}\n`);
        this.pendingCd = null;
      }
      if (this.tab === 'terminal') term.focus();
    } catch (err) {
      term.write(`\r\n\x1b[31mCould not open a terminal: ${err.message}\x1b[0m\r\n`);
    }
  }

  fitTerminal() {
    if (!this.fit || this.tab !== 'terminal' || !this.panels.terminal.offsetWidth) return;
    try {
      this.fit.fit();
    } catch {
      // xterm can throw while the element is being laid out; the next resize fixes it.
    }
  }

  onTerminalExit() {
    terminals.delete(this.termId);
    this.termId = null;
    if (this.status !== 'connected' || !this.term) return;
    this.term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
    this.panels.terminal.append(
      h('div', { class: 'terminal-ended' }, 'Terminal session ended', h('button', { class: 'btn primary', onclick: () => this.initTerminal() }, 'New Session'))
    );
  }

  teardownTerminal() {
    if (this.termId) {
      api.closeTerminal(this.termId);
      terminals.delete(this.termId);
      this.termId = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.term?.dispose();
    this.term = null;
    this.fit = null;
  }

  openTerminalAt(path) {
    if (this.termId) {
      api.writeTerminal(this.termId, `cd ${shellQuote(path)}\n`);
    } else {
      this.pendingCd = path;
      this.loaded.delete('terminal');
    }
    this.showTab('terminal');
  }
}

// ---------- Add / edit server ----------

function openServerForm(existing = null, preset = null) {
  const src = existing || {};
  const name = h('input', { class: 'input', value: src.name || preset?.alias || '', placeholder: 'e.g. Production VPS', spellcheck: false });
  const host = h('input', { class: 'input', value: src.host || preset?.host || '', placeholder: '203.0.113.10 or example.com', spellcheck: false });
  const port = h('input', { class: 'input', type: 'number', value: String(src.port || preset?.port || 22), min: 1, max: 65535 });
  const username = h('input', { class: 'input', value: src.username || preset?.username || '', placeholder: 'e.g. root or ubuntu', spellcheck: false });
  const keyPath = h('input', { class: 'input', value: src.keyPath || preset?.identityFile || '', placeholder: '~/.ssh/id_ed25519', spellcheck: false });
  const secret = h('input', { class: 'input', type: 'password' });
  const errorEl = h('div', { class: 'notice error', hidden: true });
  let authType = src.authType || (preset?.identityFile ? 'key' : 'auto');
  let clearSecret = false;

  const authOptions = h('div', { class: 'auth-options' });
  const autoHelp = h(
    'div',
    { class: 'field full' },
    h('div', { class: 'help' }, 'Uses your SSH agent and the keys in %USERPROFILE%\\.ssh (id_ed25519, id_ecdsa, id_rsa), the same way the ssh command in PowerShell does.')
  );
  const keyField = h(
    'div',
    { class: 'field full' },
    h('label', {}, 'Private key file'),
    h(
      'div',
      { class: 'field-row' },
      keyPath,
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            const picked = await api.pickKeyFile();
            if (picked) keyPath.value = picked;
          },
        },
        'Choose…'
      )
    )
  );
  const secretLabel = h('label');
  const secretHelp = h('div', { class: 'help' });
  const secretField = h('div', { class: 'field full' }, secretLabel, secret, secretHelp);

  const AUTH = [
    ['auto', 'My SSH keys', 'Same as Terminal'],
    ['key', 'Key file', 'Choose a key'],
    ['password', 'Password', 'Type a password'],
  ];
  function drawAuth() {
    authOptions.replaceChildren(
      ...AUTH.map(([id, title, desc]) =>
        h(
          'div',
          {
            class: `auth-option ${authType === id ? 'active' : ''}`,
            onclick: () => {
              authType = id;
              drawAuth();
            },
          },
          h('strong', {}, title),
          h('span', {}, desc)
        )
      )
    );
    autoHelp.hidden = authType !== 'auto';
    keyField.hidden = authType !== 'key';
    secretField.hidden = authType === 'auto';
    const hasSaved = existing && existing.authType === authType && existing.hasSecret && !clearSecret;
    const what = authType === 'password' ? 'password' : 'passphrase';
    secretLabel.textContent = authType === 'password' ? 'Password' : 'Key passphrase (optional)';
    secret.placeholder = hasSaved
      ? `Saved. Leave blank to keep the current ${what}`
      : authType === 'password'
        ? 'Leave blank to be asked when connecting'
        : 'Only if your key is protected by a passphrase';
    secretHelp.replaceChildren(
      hasSaved
        ? h(
            'button',
            {
              class: 'link-btn',
              onclick: () => {
                clearSecret = true;
                drawAuth();
              },
            },
            `Forget saved ${what}`
          )
        : 'Saved secrets are encrypted with Windows data protection (DPAPI).'
    );
  }

  let importRow = null;
  if (!existing && state.sshHosts.length) {
    const select = h(
      'select',
      {
        class: 'input',
        onchange: (e) => {
          const hh = state.sshHosts[Number(e.target.value)];
          if (!hh) return;
          name.value = hh.alias;
          host.value = hh.host;
          port.value = String(hh.port);
          if (hh.username) username.value = hh.username;
          authType = hh.identityFile ? 'key' : 'auto';
          keyPath.value = hh.identityFile || '';
          drawAuth();
        },
      },
      h('option', { value: '' }, 'Choose a host…'),
      state.sshHosts.map((hh, i) => h('option', { value: String(i) }, hh.alias === hh.host ? hh.alias : `${hh.alias} (${hh.host})`))
    );
    if (preset) select.value = String(state.sshHosts.indexOf(preset));
    importRow = h('div', { class: 'field full' }, h('label', {}, 'Import from ~/.ssh/config'), select);
  }

  const body = h(
    'div',
    {},
    errorEl,
    h(
      'div',
      { class: 'form-grid' },
      importRow,
      h('div', { class: 'field' }, h('label', {}, 'Host or IP address'), host),
      h('div', { class: 'field' }, h('label', {}, 'Port'), port),
      h('div', { class: 'field full' }, h('label', {}, 'Username'), username),
      h('div', { class: 'field full' }, h('label', {}, 'Display name'), name),
      h('div', { class: 'field full' }, h('span', { class: 'label' }, 'Sign in with'), authOptions),
      autoHelp,
      keyField,
      secretField
    )
  );
  drawAuth();

  async function save() {
    errorEl.hidden = true;
    try {
      const saved = await api.saveServer({
        id: existing?.id,
        name: name.value,
        host: host.value,
        port: port.value,
        username: username.value,
        authType,
        keyPath: keyPath.value,
        secret: secret.value || undefined,
        clearSecret,
      });
      close();
      const view = state.views.get(saved.id);
      const changed = view ? view.setServer(saved) : false;
      await reloadServers();
      selectServer(saved.id);
      if (view && changed && view.status === 'connected') {
        await view.disconnect();
        view.connect();
      }
    } catch (err) {
      errorEl.replaceChildren(icon('alert'), h('div', {}, err.message));
      errorEl.hidden = false;
    }
  }

  const removeBtn = existing
    ? h(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            close();
            const ok = await confirmDialog({
              title: `Remove "${existing.name}"?`,
              message: 'This only removes the server from Server Explorer. Nothing on the server is changed.',
              confirmText: 'Remove',
              danger: true,
            });
            if (!ok) return;
            await api.deleteServer(existing.id);
            removeView(existing.id);
            await reloadServers();
          },
        },
        icon('trash'),
        'Remove'
      )
    : null;

  const close = openModal({
    title: existing ? 'Edit Server' : 'Add Server',
    body,
    footer: [
      removeBtn,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: save }, existing ? 'Save' : 'Add & Connect'),
    ],
  });
  for (const input of [name, host, port, username, keyPath, secret]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
  }
  setTimeout(() => (existing ? name : host.value ? username : host).focus(), 30);
}

// ---------- Global wiring ----------

api.onDisconnected(({ serverId }) => state.views.get(serverId)?.onClosed('The connection to the server was lost.'));
api.onTerminalData(({ termId, data }) => terminals.get(termId)?.term?.write(data));
api.onTerminalExit(({ termId }) => terminals.get(termId)?.onTerminalExit());
api.onMenuRefresh(() => state.views.get(state.selectedId)?.refresh());
api.onJobData(({ jobId, data }) => installJobs.get(jobId)?.data(data));
api.onAiEvent((event) => aiChats.get(event.chatId)?.onAiEvent(event));
api.onJobExit((result) => installJobs.get(result.jobId)?.exit(result));

// Dropping a file outside the Files drop zone should do nothing (not navigate the window).
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Ctrl+1 … Ctrl+8 switch tabs.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || modalStack.length) return;
  const n = Number(e.key);
  const view = state.views.get(state.selectedId);
  if (view && n >= 1 && n <= TABS.length) {
    e.preventDefault();
    view.showTab(TABS[n - 1].id);
  }
});

async function init() {
  const addBtn = $('#add-server');
  addBtn.append(icon('plus'));
  addBtn.addEventListener('click', () => openServerForm());
  try {
    state.sshHosts = await api.sshConfigHosts();
  } catch {
    state.sshHosts = [];
  }
  state.servers = await api.listServers();
  // After a window reload, re-attach to connections the main process still holds.
  for (const id of await api.connectedIds()) {
    const server = serverById(id);
    if (!server) continue;
    const view = new ServerView(server);
    view.status = 'connected';
    view.tried = true;
    state.views.set(id, view);
    view.render();
  }
  renderSidebar();
  renderWelcome();
}

init();
