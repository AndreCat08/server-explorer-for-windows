# Server Explorer for Windows

A Windows desktop app for exploring and managing Linux servers over SSH. Pick a saved server and browse its files, installed software, websites, services, Docker containers, open ports, processes and user accounts, or open a terminal. You don't have to type commands, and an optional AI assistant can do the work for you while you approve each step.

Built with Electron. The UI follows Windows 11: Mica backdrop, native caption buttons, your system accent color, and light/dark mode.

## Install

1. Download `Server Explorer Setup <version>.exe` from the [Releases](https://github.com/AndreCat08/server-explorer-for-windows/releases) page.
2. Run it. The installer lets you choose the install folder.

The installer is not code-signed, so Windows SmartScreen may warn you the first time. Choose **More info → Run anyway**.

Requires 64-bit Windows. The Mica backdrop needs Windows 11 22H2 or later; on older versions the app runs without it.

## Features

### Servers and connections

- Save servers with host, port, username and a sign-in method:
  - **My SSH keys**: tries the default keys in `%USERPROFILE%\.ssh` (`id_ed25519`, `id_ecdsa`, `id_rsa`), plus an SSH agent if `SSH_AUTH_SOCK` is set.
  - **Key file**: a specific private key, with an optional passphrase.
  - **Password**.
- **Import from `.ssh\config`**: hosts in your OpenSSH config (except wildcard patterns) are offered when you add a server. Their `HostName`, `User`, `Port` and `IdentityFile` are filled in for you.
- **Host key checking**: the first time you connect, the app shows the server's key fingerprint and asks you to trust it. If you already trust the key in `%USERPROFILE%\.ssh\known_hosts`, the app accepts it without asking. If a key changes later, the app warns you before connecting.

### Tabs

Each connected server has these tabs (Ctrl+1 … Ctrl+9 jump to the first nine; Ctrl+R refreshes the current tab):

| Tab | What it shows |
| --- | --- |
| **Overview** | OS, kernel, uptime, CPU, load, memory, swap, hostname and IPs, process count, disks. |
| **AI** | The AI assistant (see below). |
| **Files** | Browse over SFTP. Upload (including drag and drop), download (folders come down as `.tar.gz`), create folders, rename, delete, and preview or edit text files (Markdown files are shown formatted, with a toggle to the raw text). Files that need root can be saved with sudo. |
| **Installed Apps** | Installed software, plus a package search for installing more. |
| **Websites** | Websites configured on the server, with a DNS check that warns when a domain doesn't point to this server. |
| **Services** | System services, with start/stop/restart. |
| **Docker** | Containers, images and Compose projects. |
| **Ports** | Listening ports and firewall rules. |
| **Processes** | Running processes. |
| **Users** | User accounts, passwords and SSH keys. For new SSH access you can paste a user's public key, or generate a key pair on the server. Only the private half is downloaded to your PC, and it's saved with permissions Windows OpenSSH accepts. |
| **Terminal** | An interactive shell (xterm.js) over the same SSH session. |

Actions that change the server (installs, service and container control, sudo saves, website and HTTPS setup) run as jobs with live output. If sudo needs a password, the app asks for it.

### Read-only database explorer

Browse databases on the server without opening a public port. The app connects through a local tunnel over the existing SSH session.

- **MongoDB**: databases, collections, documents with a JSON filter, fields sampled from the documents, indexes.
- **SQL Server (MSSQL)**: databases, tables, rows and columns. You can also run a single `SELECT`; anything that writes is refused.
- **Elasticsearch**: indices with their health, search, mappings.

### Notes

You can attach notes (connection strings, logins, ports, setup steps) to a Docker container, image or Compose project, a website, or a service. Notes are stored encrypted on your PC.

You can also save a plain-text copy on the server so teammates' Server Explorer picks it up. This is off by default. Notes can be shared with a group through `/srv/server-explorer/notes`.

### AI assistant

The AI tab can inspect the server, run commands, edit files and set things up for you. You approve each action before it happens.

**Providers**

- **Claude CLI**: uses your installed [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in). The app finds it on your PATH, or you can set the path manually. Claude's built-in tools are turned off; it can only use Server Explorer's own tools.
- **9router**: any OpenAI-compatible endpoint, by default `http://localhost:20128/v1`, with an API key and a model list.

**Security modes** (set per server)

- **Read-only** (default): only commands that inspect the server. Writes, uploads and root commands are refused.
- **Normal**: changes are allowed after you approve them. Writing to credential or key files is refused.
- **Full**: credential files can be written too, still with an approval prompt.

**Approvals**

- Every command that changes something, every file write and every upload waits for your OK.
- You can turn on **Auto-approve** for a chat. Destructive commands (recursive deletes, reboots, firewall teardown, user changes and the like) and access to credential files always ask, even then.
- Each action the assistant takes is written to an audit log (`ai-audit.log` in the app data folder), which you can open from the AI tab.

**Local folders**

You can attach folders from your PC. The assistant can read them (read-only) and upload from them to the server.

**Locking the mode**

An administrator can lock the strictest allowed mode with `{ "lockedMode": "readonly" }`, either under `aiPolicy` in `settings.json` or in `ai-policy.json` next to the app. When both are set, the stricter lock wins.

## Where your data is stored

Everything lives in the app data folder: `%APPDATA%\Server Explorer`.

- `servers.json`: saved servers.
- `known_hosts.json`: trusted host keys.
- `settings.json`: AI settings.
- Notes.

Saved passwords, key passphrases, the 9router API key and notes are encrypted with Electron [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage). On Windows that means DPAPI, tied to your Windows account. The UI never receives a stored secret back.

## Run from source

Requires Node.js (LTS) and npm on Windows.

```powershell
npm install
npm start        # run the app with Electron
npm run dist     # build the NSIS installer into dist\
```

`npm run dist` uses electron-builder. It writes `dist\Server Explorer Setup <version>.exe`, its `.blockmap`, `latest.yml`, and an unpacked build in `dist\win-unpacked\`.

### Project layout

| Path | Contents |
| --- | --- |
| `main.js` | Electron main process: window, IPC handlers, dialogs. |
| `preload.js` | The only API the sandboxed UI can call. |
| `renderer/` | UI (`index.html`, `app.js`, `styles.css`). |
| `src/ssh.js`, `src/sshfiles.js` | SSH/SFTP connections, `.ssh\config` and `known_hosts` handling. |
| `src/inspect.js`, `src/jobs.js`, `src/install.js`, `src/websites.js` | Server inspection and actions. |
| `src/db/` | Database explorer engines and the SSH tunnel. |
| `src/notes.js`, `src/store.js` | Notes and persistent settings. |
| `src/ai/` | AI assistant: providers, tools, MCP endpoint and security policy. |
