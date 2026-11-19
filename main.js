const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// Optional: run with a separate settings folder (portable use, demos, testing).
if (process.env.WEFT_USER_DATA) app.setPath('userData', path.resolve(process.env.WEFT_USER_DATA));

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'weft-config.json');

let win = null;
let vaultPath = null;
let watcher = null;
let watchTimer = null;
let suppressWatchUntil = 0;

// ---------- config ----------
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8').replace(/^﻿/, '')); } catch { /* first run */ }
  // Carry settings over from the app's earlier name ("Loom").
  try {
    const old = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'Loom', 'loom-config.json'), 'utf8'));
    return { vaultPath: old.vaultPath };
  } catch { return {}; }
}
function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2));
  return cfg;
}

// ---------- vault helpers ----------
function safeJoin(rel) {
  const full = path.resolve(vaultPath, rel);
  const root = path.resolve(vaultPath);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path escapes vault');
  return full;
}
const toRel = (full) => path.relative(vaultPath, full).split(path.sep).join('/');

async function walk(dir, out = { files: [], folders: [] }) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { out.folders.push(toRel(full)); await walk(full, out); }
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.files.push(full);
  }
  return out;
}

async function listNotes() {
  const { files, folders } = await walk(vaultPath);
  const notes = await Promise.all(files.map(async (full) => {
    const [content, stat] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
    const ctime = stat.birthtimeMs && stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, stat.mtimeMs) : stat.mtimeMs;
    return { path: toRel(full), content, mtime: stat.mtimeMs, ctime };
  }));
  return { notes, folders };
}

function startWatching() {
  if (watcher) { watcher.close(); watcher = null; }
  try {
    watcher = fs.watch(vaultPath, { recursive: true }, () => {
      if (Date.now() < suppressWatchUntil) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => win && win.webContents.send('vault:changed'), 300);
    });
  } catch { /* watching is best-effort */ }
}
const quiet = () => { suppressWatchUntil = Date.now() + 800; };

const SEED = {
  'Welcome.md': `Weft is a quiet place for connected thinking. Every note is a plain **markdown file** in your vault folder, so your notes are always yours.

## Start here
- Read [[Linking notes]] to learn how notes connect
- Open the [[Graph view]] to see your whole web of ideas
- Start a [[Daily notes|daily note]] with \`Ctrl+Shift+D\`
- Skim the [[Keyboard shortcuts]]

> Tip: hold **Ctrl** and hover any link to preview it. Click a link to a note that doesn't exist yet and Weft creates it.

#weft #start`,
  'Linking notes.md': `Type \`[[\` to link to another note. A list of matching notes appears — pick one or keep typing a new name.

- \`[[Graph view]]\` → [[Graph view]]
- \`[[Graph view|an alias]]\` → [[Graph view|an alias]]

Every note shows its **backlinks** and a **local graph** in the right panel: the notes that point *to* it and its neighbourhood. That's how ideas written weeks apart find each other again.

Tags like #weft group notes loosely. Click a tag to see everything that shares it.

Back to [[Welcome]].

#weft #guide`,
  'Graph view.md': `The graph shows every note as a node and every [[Linking notes|link]] as a line.

- **Hover** a node to light up its neighbours
- **Click** a node to open it
- **Drag** nodes around, scroll to zoom
- Press **Time-lapse** to watch your vault grow in the order you wrote it
- Export the graph as an image or an interactive web page

Notes with more connections grow larger. Try linking to [[Ideas]] from a few notes and watch it grow.

#weft #guide`,
  'Daily notes.md': `Press \`Ctrl+Shift+D\` (or the sun in the left bar) to open today's note. The **calendar** in the sidebar shows which days have a daily note and how active you were — darker days mean more writing.

Daily notes live in the \`Daily\` folder; change that in Settings.

#guide`,
  'Keyboard shortcuts.md': `| Action | Keys |
| --- | --- |
| Command palette | \`Ctrl+P\` |
| Quick switcher | \`Ctrl+O\` |
| New note | \`Ctrl+N\` |
| Today's daily note | \`Ctrl+Shift+D\` |
| New tab / close tab | \`Ctrl+T\` / \`Ctrl+W\` |
| Toggle reading view | \`Ctrl+E\` |
| Graph view | \`Ctrl+G\` |
| Focus mode | \`Ctrl+Shift+Enter\` |
| Settings | \`Ctrl+,\` |

See also [[Welcome]].

#guide`,
  'Ideas.md': `A scratchpad for half-formed thoughts.

- [ ] Write a note about something I learned today
- [ ] Link it to an older note
- [x] Install Weft

Related: [[Graph view]], [[Projects/Reading list]]

#ideas`,
  'Projects/Reading list.md': `Books and articles worth coming back to.

- *How to Take Smart Notes* — on building a web of linked notes
- [[Ideas]] for what to read next

#reading #ideas`,
};

async function ensureDefaultVault() {
  const docs = app.getPath('documents');
  const dir = path.join(docs, 'Weft Vault');
  const legacy = path.join(docs, 'Loom Vault');
  if (!fs.existsSync(dir) && fs.existsSync(legacy)) return legacy;
  if (!fs.existsSync(dir)) {
    for (const [rel, body] of Object.entries(SEED)) {
      const full = path.join(dir, rel);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, body, 'utf8');
    }
  }
  return dir;
}

async function setVault(dir) {
  vaultPath = dir;
  writeConfig({ vaultPath: dir });
  startWatching();
}

// ---------- graph web-page export ----------
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function buildGraphHtml({ title, nodes, links, vars }, graphJs) {
  const css = Object.entries(vars || {}).filter(([k]) => /^--[\w-]+$/.test(k)).map(([k, v]) => `${k}: ${String(v).replace(/[;{}<]/g, '')};`).join(' ');
  const data = JSON.stringify({ nodes, links }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} — graph</title>
<style>
:root { ${css} }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font: 14px/1.5 "Segoe UI", -apple-system, system-ui, sans-serif; }
body { background: var(--graph-bg); }
canvas { position: fixed; inset: 0; width: 100%; height: 100%; cursor: grab; touch-action: none; }
canvas.grabbing { cursor: grabbing; } canvas.pointer { cursor: pointer; }
.hud { position: fixed; top: 16px; left: 20px; pointer-events: none; }
.hud h1 { margin: 0; font-size: 16px; font-weight: 650; }
.hud p { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.tip { position: fixed; pointer-events: none; padding: 8px 12px; border-radius: 10px; background: var(--surface); box-shadow: var(--shadow); font-size: 13px; display: none; }
.foot { position: fixed; bottom: 14px; right: 18px; color: var(--muted); font-size: 11.5px; }
</style></head><body>
<canvas id="c"></canvas>
<div class="hud"><h1>${escHtml(title)}</h1><p>${nodes.length} notes · ${links.length} links · drag, scroll to zoom, hover to explore</p></div>
<div class="tip" id="tip"></div>
<div class="foot">Made with Weft</div>
<script>${graphJs}</script>
<script>
const DATA = ${data};
const tip = document.getElementById('tip');
const g = new Graph(document.getElementById('c'), {
  onHover(n, x, y) {
    if (!n) { tip.style.display = 'none'; return; }
    tip.textContent = n.label; tip.style.display = 'block';
    tip.style.left = (x + 14) + 'px'; tip.style.top = (y + 14) + 'px';
  },
});
g.start();
g.setData(DATA.nodes, DATA.links);
g.alpha = 0.08;
</script></body></html>`;
}

// ---------- window ----------
function overlayFor(mode) {
  return mode === 'dark' ? { color: '#00000000', symbolColor: '#a1a1aa', height: 40 } : { color: '#00000000', symbolColor: '#52525b', height: 40 };
}
function createWindow() {
  const cfg = readConfig();
  const mode = cfg.themeMode || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 760, minHeight: 500,
    backgroundColor: cfg.themeBg || (mode === 'dark' ? '#131317' : '#f4f3ef'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : overlayFor(mode),
    trafficLightPosition: { x: 14, y: 13 },
    show: false,
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The app is a single page: never navigate away from it (dropped files, stray links).
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });
  // Spelling suggestions on right-click.
  win.webContents.on('context-menu', (_e, params) => {
    if (!params.misspelledWord) return;
    const items = params.dictionarySuggestions.slice(0, 6).map((s) => ({ label: s, click: () => win.webContents.replaceMisspelling(s) }));
    items.push({ type: 'separator' }, { label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    Menu.buildFromTemplate(items).popup();
  });
}

function setupMenu() {
  if (process.platform === 'darwin') {
    // macOS needs a menu for Cmd+C / Cmd+V. Undo/redo are left to the editor's own history.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null); // Weft handles its own shortcuts (Ctrl+W closes a tab, not the window)
  }
}

// ---------- IPC ----------
ipcMain.handle('vault:get', async () => {
  const cfg = readConfig();
  let dir = cfg.vaultPath;
  if (!dir || !fs.existsSync(dir)) dir = await ensureDefaultVault();
  await setVault(dir);
  return { path: vaultPath, name: path.basename(vaultPath) };
});

ipcMain.handle('vault:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open or create a vault folder', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  await setVault(r.filePaths[0]);
  return { path: vaultPath, name: path.basename(vaultPath) };
});

ipcMain.handle('vault:reveal', () => shell.openPath(vaultPath));
ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.handle('notes:list', () => listNotes());

ipcMain.handle('note:write', async (_e, rel, content) => {
  const full = safeJoin(rel);
  quiet();
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf8');
  const stat = await fsp.stat(full);
  return { mtime: stat.mtimeMs };
});

ipcMain.on('note:writeSync', (e, rel, content) => {
  try { quiet(); fs.writeFileSync(safeJoin(rel), content, 'utf8'); e.returnValue = true; }
  catch { e.returnValue = false; }
});

ipcMain.handle('note:create', async (_e, rel, content = '') => {
  let full = safeJoin(rel);
  const base = full.replace(/\.md$/i, '');
  for (let i = 1; fs.existsSync(full); i++) full = `${base} ${i}.md`;
  quiet();
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf8');
  return toRel(full);
});

ipcMain.handle('note:rename', async (_e, fromRel, toRelPath) => {
  const from = safeJoin(fromRel);
  const to = safeJoin(toRelPath);
  if (from === to) return toRelPath;
  if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error('A note with that name already exists');
  quiet();
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return toRel(to);
});

ipcMain.handle('note:delete', async (_e, rel) => {
  quiet();
  await shell.trashItem(safeJoin(rel));
  return true;
});

ipcMain.handle('folder:create', async (_e, rel) => {
  quiet();
  await fsp.mkdir(safeJoin(rel), { recursive: true });
  return true;
});

ipcMain.handle('theme:set', (_e, { mode, bg } = {}) => {
  writeConfig({ themeMode: mode, themeBg: bg });
  if (!win) return;
  if (process.platform !== 'darwin') { try { win.setTitleBarOverlay(overlayFor(mode)); } catch { /* unsupported */ } }
  if (bg) win.setBackgroundColor(bg);
});

ipcMain.handle('export:save', async (_e, { defaultName, filters, dataUrl, text }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('pictures'), defaultName), filters });
  if (r.canceled || !r.filePath) return null;
  const buf = dataUrl ? Buffer.from(dataUrl.split(',')[1], 'base64') : Buffer.from(text || '', 'utf8');
  await fsp.writeFile(r.filePath, buf);
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});

ipcMain.handle('export:graphHtml', async (_e, payload) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `${payload.title || 'Weft'} graph.html`),
    filters: [{ name: 'Web page', extensions: ['html'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const graphJs = await fsp.readFile(path.join(__dirname, 'renderer', 'graph.js'), 'utf8');
  await fsp.writeFile(r.filePath, buildGraphHtml(payload, graphJs), 'utf8');
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});

// One window per vault: a second launch focuses the existing window instead of
// opening another editor that could overwrite the same files.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => { setupMenu(); createWindow(); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}
app.on('window-all-closed', () => { if (watcher) watcher.close(); app.quit(); });
