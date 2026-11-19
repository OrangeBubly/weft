/* Weft — renderer */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const store = {
  get(k, d) { try { const v = localStorage.getItem('weft.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('weft.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const THEMES = [
  { id: 'midnight', name: 'Midnight', mode: 'dark', prev: ['#111114', '#1b1b21', '#9b8cff', '#7dd3c0'] },
  { id: 'forest', name: 'Forest', mode: 'dark', prev: ['#0e1411', '#17211c', '#6edc9f', '#e8c872'] },
  { id: 'ember', name: 'Ember', mode: 'dark', prev: ['#151110', '#211a18', '#f59e6b', '#f2c66d'] },
  { id: 'paper', name: 'Paper', mode: 'light', prev: ['#fbfaf8', '#ffffff', '#6b57e8', '#0f8f78'] },
  { id: 'mist', name: 'Mist', mode: 'light', prev: ['#f5f7fa', '#ffffff', '#2f6fe4', '#0e8a9a'] },
];
const ACCENTS = ['#9b8cff', '#60a5fa', '#2dd4bf', '#4ade80', '#fbbf24', '#fb923c', '#f472b6', '#f87171'];
const DEFAULTS = {
  theme: 'midnight', darkTheme: 'midnight', lightTheme: 'paper', accent: null,
  font: 'sans', fontSize: 16, fullWidth: false, livePreview: true, typewriter: false,
  defaultMode: 'edit', dailyFolder: 'Daily', spellcheck: true,
};
let settings = { ...DEFAULTS, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

const S = {
  vault: null,
  notes: new Map(),
  folders: [],
  nameIdx: new Map(),
  pathIdx: new Map(),
  panes: [],
  active: null,
  view: 'editor',
  panel: 'files',
  dirty: new Set(),
  timers: new Map(),
  expanded: new Set(),
  graph: null,
  lg: null,
  lgDepth: store.get('lgDepth', 2),
  gopts: { tags: false, ghosts: true, orphans: true, filter: '' },
  calMonth: (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(),
};
const el = { tree: $('#tree'), ctx: $('#ctx'), modal: $('#modal-root'), hover: $('#hover'), panes: $('#panes') };

/* ================= Parsing & index ================= */
const WIKI_RE = /\[\[([^[\]\n]+?)\]\]/g;
const WIKI_PARTS = /\[\[([^\]\n|#]+)(#[^\]\n|]*)?(\|[^\]\n]*)?\]\]/g;
const TAG_RE = /(^|[\s(])#([A-Za-z][\w\-/]*)/g;
const blank = (m) => m.replace(/[^\n]/g, ' ');
const stripCode = (md) => md.replace(/```[\s\S]*?(```|$)/g, blank).replace(/`[^`\n]*`/g, blank);

function setMeta(note) {
  const parts = note.path.split('/');
  note.name = parts.pop().replace(/\.md$/i, '');
  note.folder = parts.join('/');
}
function parseNote(note) {
  const body = stripCode(note.content);
  note.links = [];
  let m;
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(body))) {
    const [tp, alias] = m[1].split('|');
    const target = tp.split('#')[0].trim();
    if (target) note.links.push({ target, alias: alias && alias.trim(), index: m.index });
  }
  note.tags = new Set();
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(body))) note.tags.add(m[2].toLowerCase());
}
function rebuildIndex() {
  S.nameIdx.clear(); S.pathIdx.clear();
  const sorted = [...S.notes.values()].sort((a, b) => a.path.length - b.path.length);
  for (const n of sorted) {
    const lname = n.name.toLowerCase();
    if (!S.nameIdx.has(lname)) S.nameIdx.set(lname, n.path);
    S.pathIdx.set(n.path.replace(/\.md$/i, '').toLowerCase(), n.path);
  }
}
function resolve(target) {
  const t = String(target).trim().replace(/\.md$/i, '').toLowerCase();
  return S.pathIdx.get(t) || S.nameIdx.get(t) || null;
}
function linkTextFor(path) {
  const n = S.notes.get(path);
  return S.nameIdx.get(n.name.toLowerCase()) === path ? n.name : path.replace(/\.md$/i, '');
}
function backlinksOf(path) {
  const out = [];
  for (const n of S.notes.values()) {
    if (n.path === path) continue;
    const hits = n.links.filter((l) => resolve(l.target) === path);
    if (!hits.length) continue;
    const lines = new Set();
    for (const h of hits) {
      const s = n.content.lastIndexOf('\n', h.index) + 1;
      let e = n.content.indexOf('\n', h.index); if (e < 0) e = n.content.length;
      lines.add(n.content.slice(s, e).trim());
    }
    out.push({ note: n, lines: [...lines] });
  }
  return out.sort((a, b) => a.note.name.localeCompare(b.note.name));
}
const curPath = () => (S.active ? S.active.path : null);
const cur = () => S.notes.get(curPath());
const allTags = () => {
  const m = new Map();
  for (const n of S.notes.values()) for (const t of n.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
const created = (n) => n.ctime || n.mtime;

/* ================= Loading ================= */
async function loadNotes() {
  const { notes, folders } = await loom.listNotes();
  const next = new Map();
  for (const raw of notes) {
    const prev = S.notes.get(raw.path);
    // Keep the in-memory version of any note with unsaved edits.
    const n = prev && S.dirty.has(raw.path) ? prev : { ...raw };
    setMeta(n); parseNote(n);
    next.set(n.path, n);
  }
  S.notes = next;
  S.folders = folders;
  rebuildIndex();
}

async function reloadFromDisk() {
  await loadNotes();
  renderTree(); renderTags(); runSearch(); renderCalendar();
  for (const p of S.panes) {
    for (const t of p.tabs) if (t.path && !S.notes.has(t.path)) t.path = null;
    p.refreshContent(true);
  }
  renderRight(); renderStatus(); refreshEditors();
  if (S.view === 'graph') refreshGraph();
}

/* ================= File tree ================= */
function buildTree() {
  const root = { path: '', folders: new Map(), notes: [] };
  const ensure = (p) => {
    if (!p) return root;
    let node = root, acc = '';
    for (const part of p.split('/')) {
      acc = acc ? acc + '/' + part : part;
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path: acc, folders: new Map(), notes: [] });
      node = node.folders.get(part);
    }
    return node;
  };
  S.folders.forEach(ensure);
  for (const n of S.notes.values()) ensure(n.folder).notes.push(n);
  return root;
}
function countNotes(f) { let c = f.notes.length; for (const s of f.folders.values()) c += countNotes(s); return c; }
function renderFolder(f) {
  let h = '';
  const subs = [...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of subs) {
    const open = S.expanded.has(s.path);
    h += `<div class="folder ${open ? 'open' : ''}" data-folder="${esc(s.path)}">
      <div class="tree-item" data-folder-row="${esc(s.path)}">
        <span class="ti-chev">${icon('chev', 14)}</span><span class="ti-name">${esc(s.name)}</span>
        <span class="ti-count">${countNotes(s)}</span>
      </div><div class="children">${renderFolder(s)}</div></div>`;
  }
  const notes = [...f.notes].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const n of notes) {
    h += `<div class="tree-item ${n.path === curPath() ? 'active' : ''}" data-path="${esc(n.path)}" draggable="true" title="${esc(n.path)}">
      <span class="ti-dot"></span><span class="ti-name">${esc(n.name)}</span></div>`;
  }
  return h;
}
function renderTree() {
  el.tree.innerHTML = renderFolder(buildTree()) || '<div class="empty-hint">Your vault is empty.<br>Press Ctrl+N to write your first note.</div>';
}
function markActiveInTree() {
  const p = curPath();
  $$('.tree-item[data-path]', el.tree).forEach((x) => x.classList.toggle('active', x.dataset.path === p));
}
function revealInTree(path) {
  const parts = path.split('/'); parts.pop();
  let acc = '', changed = false;
  for (const p of parts) { acc = acc ? acc + '/' + p : p; if (!S.expanded.has(acc)) { S.expanded.add(acc); changed = true; } }
  if (changed) { saveExpanded(); renderTree(); }
}
const saveExpanded = () => store.set('expanded:' + S.vault.path, [...S.expanded]);

el.tree.addEventListener('click', (e) => {
  const row = e.target.closest('.tree-item');
  if (!row) return;
  if (row.dataset.folderRow != null) {
    const p = row.dataset.folderRow;
    S.expanded.has(p) ? S.expanded.delete(p) : S.expanded.add(p);
    row.parentElement.classList.toggle('open');
    saveExpanded();
  } else if (row.dataset.path) openNote(row.dataset.path, { newTab: e.ctrlKey || e.metaKey });
});
el.tree.addEventListener('auxclick', (e) => {
  const row = e.target.closest('[data-path]');
  if (row && e.button === 1) openNote(row.dataset.path, { newTab: true });
});
el.tree.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const row = e.target.closest('.tree-item');
  if (row && row.dataset.path) {
    const p = row.dataset.path;
    showMenu(e.clientX, e.clientY, [
      { label: 'Open in new tab', icon: 'plus', run: () => openNote(p, { newTab: true }) },
      { label: 'Open to the right', icon: 'split', run: () => openToRight(p) },
      { label: 'Rename…', icon: 'edit', run: () => renameDialog(p) },
      { label: 'Show in graph', icon: 'graph', run: () => openNote(p).then(() => showGraph(true)) },
      '-',
      { label: 'Delete', icon: 'trash', danger: true, run: () => deleteNote(p) },
    ]);
  } else {
    const folder = row ? row.dataset.folderRow : '';
    showMenu(e.clientX, e.clientY, [
      { label: 'New note', icon: 'plus', run: () => newNote(folder) },
      { label: 'New folder', icon: 'folderPlus', run: () => newFolder(folder) },
    ]);
  }
});
el.tree.addEventListener('dragstart', (e) => {
  const row = e.target.closest('[data-path]');
  if (row) e.dataTransfer.setData('text/weft-path', row.dataset.path);
});
el.tree.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes('text/weft-path')) return;
  e.preventDefault();
  $$('.drop', el.tree).forEach((x) => x.classList.remove('drop'));
  const f = e.target.closest('[data-folder]');
  if (f) f.querySelector('[data-folder-row]').classList.add('drop');
});
el.tree.addEventListener('dragleave', (e) => { if (!el.tree.contains(e.relatedTarget)) $$('.drop', el.tree).forEach((x) => x.classList.remove('drop')); });
el.tree.addEventListener('drop', async (e) => {
  const p = e.dataTransfer.getData('text/weft-path');
  $$('.drop', el.tree).forEach((x) => x.classList.remove('drop'));
  if (!p) return;
  e.preventDefault();
  // Dropping on a folder, or on any note inside it, moves the note into that folder.
  const f = e.target.closest('[data-folder]');
  const folder = f ? f.dataset.folder : '';
  const n = S.notes.get(p);
  if (!n || n.folder === folder) return;
  await movePath(p, (folder ? folder + '/' : '') + n.name + '.md');
  if (folder) { S.expanded.add(folder); saveExpanded(); renderTree(); }
});

/* ================= Panes & tabs ================= */
class Pane {
  constructor() {
    this.tabs = [];
    this.idx = -1;
    this.loading = false;
    this.el = document.createElement('div');
    this.el.className = 'pane';
    this.el.innerHTML = `
      <div class="tabbar"><div class="tabs"></div><button class="icon-btn tab-new" title="New tab (Ctrl+T)">${icon('plus', 15)}</button></div>
      <div class="pane-body">
        <div class="note-view hidden">
          <div class="note-toolbar">
            <div class="nav-btns">
              <button class="icon-btn sm" data-a="back" title="Back (Alt+←)">${icon('back', 15)}</button>
              <button class="icon-btn sm" data-a="fwd" title="Forward (Alt+→)">${icon('forward', 15)}</button>
            </div>
            <div class="crumbs"></div>
            <div class="note-actions">
              <div class="seg"><button data-mode="edit" title="Editing (Ctrl+E)">${icon('pen')}</button><button data-mode="read" title="Reading (Ctrl+E)">${icon('eye')}</button></div>
              <button class="icon-btn" data-a="split" title="Split right">${icon('split')}</button>
              <button class="icon-btn" data-a="right" title="Toggle info panel">${icon('panelRight')}</button>
              <button class="icon-btn" data-a="more" title="More">${icon('dots')}</button>
            </div>
          </div>
          <div class="note-scroll scroll"><div class="note-inner">
            <input class="note-title" spellcheck="false" placeholder="Untitled" />
            <div class="cm-host"></div>
            <article class="md reader hidden"></article>
          </div></div>
        </div>
        <div class="pane-empty">
          <div class="empty-orb"></div>
          <h2>No note open</h2>
          <p>Pick a note from the sidebar, or start something new.</p>
          <div class="empty-actions">
            <button class="btn primary" data-a="new">New note <kbd>Ctrl N</kbd></button>
            <button class="btn" data-a="switch">Open note <kbd>Ctrl O</kbd></button>
            <button class="btn" data-a="daily">Today <kbd>Ctrl Shift D</kbd></button>
          </div>
        </div>
      </div>`;
    this.$ = (s) => $(s, this.el);
    this.titleEl = this.$('.note-title');
    this.scrollEl = this.$('.note-scroll');
    this.reader = this.$('.reader');
    this.host = this.$('.cm-host');
    this.editor = WeftEditor.create({
      parent: this.host,
      livePreview: settings.livePreview,
      typewriter: settings.typewriter,
      placeholder: 'Start writing…  Type [[ to link a note.',
      onChange: (doc) => this.onEdit(doc),
      onOpenLink: (t, newTab) => openOrCreate(t, { newTab, pane: this }),
      onOpenUrl: openUrl,
      onTag: (t) => searchFor('#' + t),
      onHoverLink: (t, anchor, e) => hoverLink(t, anchor, e, true),
      onHoverEnd: () => hoverEnd(),
      getLinkOptions: (q) => linkOptions(q, this.path),
      getTags: () => allTags().map((x) => x[0]),
      resolveLink: (t) => !!resolve(t),
      resolveImage: (href) => imageUrl(href, this.note && this.note.folder),
    });
    this.bind();
  }

  get tab() { return this.tabs[this.idx]; }
  get path() { return this.tab ? this.tab.path : null; }
  get note() { return S.notes.get(this.path); }

  bind() {
    this.el.addEventListener('mousedown', () => setActivePane(this), true);
    this.el.addEventListener('focusin', () => setActivePane(this));
    this.$('.tab-new').onclick = () => this.newTab();
    const tabsEl = this.$('.tabs');
    tabsEl.addEventListener('click', (e) => {
      const t = e.target.closest('.tab'); if (!t) return;
      const i = Number(t.dataset.i);
      if (e.target.closest('.tab-x')) { e.stopPropagation(); this.closeTab(i); } else this.switchTo(i);
    });
    tabsEl.addEventListener('auxclick', (e) => { const t = e.target.closest('.tab'); if (t && e.button === 1) this.closeTab(Number(t.dataset.i)); });
    tabsEl.addEventListener('dblclick', (e) => { if (!e.target.closest('.tab')) this.newTab(); });
    tabsEl.addEventListener('wheel', (e) => { tabsEl.scrollLeft += e.deltaY; }, { passive: true });
    this.$('.seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) this.setMode(b.dataset.mode); });
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      const a = b.dataset.a;
      if (a === 'back') this.back();
      else if (a === 'fwd') this.fwd();
      else if (a === 'split') splitRight();
      else if (a === 'right') toggleRight();
      else if (a === 'more') this.moreMenu(b);
      else if (a === 'new') newNote();
      else if (a === 'switch') openSwitcher();
      else if (a === 'daily') openDaily();
    });
    this.titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); this.editor.focus(); }
      if (e.key === 'Escape') { this.titleEl.value = this.note ? this.note.name : ''; this.editor.focus(); }
    });
    this.titleEl.addEventListener('blur', () => commitTitle(this));
    this.reader.addEventListener('click', (e) => readerClick(e, this));
    this.reader.addEventListener('mouseover', (e) => { const a = e.target.closest('.wikilink'); if (a) hoverLink(a.dataset.target, a, e, false); });
  }

  onEdit(doc) {
    if (this.loading) return;
    const n = this.note; if (!n || n.content === doc) return;
    n.content = doc;
    parseNote(n);
    markDirty(n.path);
    for (const p of S.panes) if (p !== this && p.path === n.path) p.refreshContent();
    renderStatus();
    afterEdit();
  }

  saveTabState() {
    const t = this.tab; if (!t || !t.path) return;
    t.sel = this.editor.getSelection();
    t.scroll = this.scrollEl.scrollTop;
  }

  open(path, { newTab = false } = {}) {
    if (!newTab) {
      const existing = this.tabs.findIndex((t) => t.path === path);
      if (existing >= 0) { this.switchTo(existing); return; }
    }
    if (newTab || !this.tab) {
      this.saveTabState();
      this.tabs.splice(this.idx + 1, 0, { path, mode: settings.defaultMode, back: [], fwd: [], sel: 0, scroll: 0 });
      this.idx += 1;
    } else {
      this.saveTabState();
      const t = this.tab;
      if (t.path && t.path !== path) { t.back.push(t.path); t.fwd = []; }
      t.path = path; t.sel = 0; t.scroll = 0;
    }
    this.show(true);
  }
  newTab() {
    this.saveTabState();
    this.tabs.splice(this.idx + 1, 0, { path: null, mode: settings.defaultMode, back: [], fwd: [], sel: 0, scroll: 0 });
    this.idx += 1;
    this.show();
    setActivePane(this);
  }
  switchTo(i) {
    if (i === this.idx || !this.tabs[i]) return;
    this.saveTabState();
    this.idx = i;
    this.show(true);
  }
  closeTab(i) {
    if (!this.tabs[i]) return;
    const closing = this.tabs[i];
    if (closing.path) save(closing.path);
    if (i === this.idx) this.saveTabState();
    this.tabs.splice(i, 1);
    if (!this.tabs.length) {
      if (S.panes.length > 1) { removePane(this); return; }
      this.idx = -1;
    } else if (i < this.idx || this.idx >= this.tabs.length) this.idx = Math.max(0, this.idx - 1);
    this.show(true);
  }
  back() { const t = this.tab; if (!t || !t.back.length) return; this.saveTabState(); t.fwd.push(t.path); t.path = t.back.pop(); t.sel = 0; this.show(true); }
  fwd() { const t = this.tab; if (!t || !t.fwd.length) return; this.saveTabState(); t.back.push(t.path); t.path = t.fwd.pop(); t.sel = 0; this.show(true); }

  setMode(mode) {
    if (!this.tab) return;
    this.tab.mode = mode;
    this.applyMode();
    if (mode === 'edit') this.editor.focus();
    saveWorkspace();
  }
  applyMode() {
    const mode = this.tab ? this.tab.mode : 'edit';
    $$('.seg button', this.el).forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    this.host.classList.toggle('hidden', mode !== 'edit');
    this.reader.classList.toggle('hidden', mode !== 'read');
    if (mode === 'read') renderReader(this);
  }

  // Render tabs + the current tab's note.
  show(animate = false) {
    this.renderTabs();
    const n = this.note;
    this.$('.note-view').classList.toggle('hidden', !n);
    this.$('.pane-empty').classList.toggle('hidden', !!n);
    if (n) {
      const t = this.tab;
      this.loading = true;
      this.titleEl.value = n.name;
      this.editor.load(n.content, t.sel || 0);
      this.loading = false;
      this.applyMode();
      const inner = this.$('.note-inner');
      if (animate) { inner.classList.remove('enter'); void inner.offsetWidth; inner.classList.add('enter'); }
      requestAnimationFrame(() => { this.scrollEl.scrollTop = t.scroll || 0; });
      this.renderCrumbs();
      this.$('[data-a="back"]').disabled = !t.back.length;
      this.$('[data-a="fwd"]').disabled = !t.fwd.length;
      this.$('[data-a="back"]').style.opacity = t.back.length ? 1 : 0.35;
      this.$('[data-a="fwd"]').style.opacity = t.fwd.length ? 1 : 0.35;
    }
    if (this === S.active) onActiveNoteChanged();
    saveWorkspace();
  }
  // Called when the note's content or name changed outside this editor.
  refreshContent(full = false) {
    const n = this.note;
    if (full) { this.show(); return; }
    if (!n) return;
    this.loading = true;
    this.editor.setDoc(n.content);
    this.loading = false;
    if (document.activeElement !== this.titleEl) this.titleEl.value = n.name;
    if (this.tab.mode === 'read') renderReader(this);
    this.renderTabs(); this.renderCrumbs();
  }
  renderTabs() {
    this.$('.tabs').innerHTML = this.tabs.map((t, i) => {
      const n = S.notes.get(t.path);
      const name = n ? n.name : 'New tab';
      return `<div class="tab ${i === this.idx ? 'active' : ''} ${t.path && S.dirty.has(t.path) ? 'dirty' : ''}" data-i="${i}" title="${esc(t.path || 'New tab')}">
        <span class="tab-name">${esc(name)}</span><span class="tab-x">${icon('x', 13)}</span></div>`;
    }).join('');
    const a = this.$('.tab.active'); if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  renderCrumbs() {
    const n = this.note; if (!n) return;
    const parts = n.folder ? n.folder.split('/') : [];
    this.$('.crumbs').innerHTML = [esc(S.vault.name), ...parts.map(esc), `<b>${esc(n.name)}</b>`].join('<span>/</span>');
  }
  moreMenu(btn) {
    const r = btn.getBoundingClientRect();
    const p = this.path;
    showMenu(r.right - 240, r.bottom + 6, [
      { label: 'Rename…', icon: 'edit', run: () => renameDialog(p) },
      { label: 'Open to the right', icon: 'split', run: () => openToRight(p) },
      { label: 'Show in graph', icon: 'graph', run: () => showGraph(true) },
      { label: 'Toggle checkbox', icon: 'check', key: 'Ctrl Enter', run: () => this.editor.toggleTask() },
      '-',
      { label: 'Delete note', icon: 'trash', danger: true, run: () => deleteNote(p) },
    ]);
  }
}

function setActivePane(p) {
  if (S.active === p) return;
  S.active = p;
  for (const x of S.panes) x.el.classList.toggle('active', x === p);
  onActiveNoteChanged();
}
function onActiveNoteChanged() {
  const n = cur();
  document.title = n ? `${n.name} — Weft` : 'Weft';
  if (n) { store.set('last:' + S.vault.path, n.path); pushRecent(n.path); revealInTree(n.path); }
  markActiveInTree(); renderRight(); renderStatus(); updateLocalGraph();
  if (S.graph) S.graph.setCurrent(curPath());
}
function addPane() {
  const p = new Pane();
  S.panes.push(p);
  el.panes.appendChild(p.el);
  el.panes.classList.toggle('split', S.panes.length > 1);
  return p;
}
function removePane(p) {
  const i = S.panes.indexOf(p);
  if (i < 0 || S.panes.length === 1) return;
  p.editor.destroy();
  p.el.remove();
  S.panes.splice(i, 1);
  el.panes.classList.toggle('split', S.panes.length > 1);
  S.active = null;
  setActivePane(S.panes[Math.max(0, i - 1)]);
  saveWorkspace();
}
function splitRight() {
  const src = S.active;
  if (S.panes.length > 1) { const other = S.panes.find((p) => p !== src); if (src.path) other.open(src.path, { newTab: true }); setActivePane(other); return; }
  const p = addPane();
  if (src.path) p.open(src.path); else p.show();
  setActivePane(p);
}
function openToRight(path) {
  let other = S.panes.find((p) => p !== S.active);
  if (!other) other = addPane();
  other.open(path, { newTab: !!other.path });
  setActivePane(other);
}
async function openNote(path, { newTab = false, pane } = {}) {
  if (!S.notes.has(path)) return;
  if (S.view === 'graph') showGraph(false);
  const p = pane || S.active;
  p.open(path, { newTab });
  setActivePane(p);
}
function cycleTab(dir) {
  const p = S.active; if (!p.tabs.length) return;
  p.switchTo((p.idx + dir + p.tabs.length) % p.tabs.length);
}
const saveWorkspace = debounce(() => {
  if (!S.vault) return;
  store.set('workspace:' + S.vault.path, {
    panes: S.panes.map((p) => ({ idx: p.idx, tabs: p.tabs.map((t) => ({ path: t.path, mode: t.mode })) })),
    active: S.panes.indexOf(S.active),
  });
}, 300);
function restoreWorkspace() {
  const ws = store.get('workspace:' + S.vault.path, null);
  const panes = ws && ws.panes && ws.panes.length ? ws.panes : null;
  if (!panes) return false;
  panes.slice(0, 2).forEach((pd, i) => {
    const p = i === 0 ? S.panes[0] : addPane();
    p.tabs = pd.tabs.filter((t) => !t.path || S.notes.has(t.path)).map((t) => ({ path: t.path, mode: t.mode || 'edit', back: [], fwd: [], sel: 0, scroll: 0 }));
    p.idx = p.tabs.length ? Math.min(Math.max(0, pd.idx), p.tabs.length - 1) : -1;
  });
  for (const p of [...S.panes]) if (!p.tabs.length && S.panes.length > 1) removePane(p);
  S.active = null;
  setActivePane(S.panes[Math.min(Math.max(0, ws.active), S.panes.length - 1)]);
  S.panes.forEach((p) => p.show());
  return S.panes.some((p) => p.tabs.length);
}
const refreshEditors = debounce(() => S.panes.forEach((p) => p.editor.refresh()), 120);

/* ================= Saving ================= */
function markDirty(path) {
  const was = S.dirty.has(path);
  S.dirty.add(path);
  clearTimeout(S.timers.get(path));
  S.timers.set(path, setTimeout(() => save(path), 450));
  setSaveStatus();
  if (!was) S.panes.forEach((p) => p.renderTabs());
}
async function save(path) {
  clearTimeout(S.timers.get(path)); S.timers.delete(path);
  if (!S.dirty.has(path)) return;
  const n = S.notes.get(path);
  S.dirty.delete(path);
  if (n) {
    try { const r = await loom.writeNote(path, n.content); n.mtime = r.mtime; }
    catch (err) { S.dirty.add(path); toast('Could not save: ' + err.message, true); }
  }
  setSaveStatus();
  if (!S.dirty.has(path)) S.panes.forEach((p) => p.renderTabs());
}
async function flushAll() { await Promise.all([...S.dirty].map(save)); }
function setSaveStatus() {
  const st = $('#st-save');
  if (!cur()) { st.textContent = ''; return; }
  const dirty = S.dirty.has(curPath());
  st.textContent = dirty ? 'Editing…' : 'Saved';
  st.className = dirty ? 'saving' : '';
}
const afterEdit = debounce(() => {
  renderRight(); renderTags(); updateLocalGraph(); refreshEditors();
  if (S.panel === 'search') runSearch();
  if (S.panel === 'calendar') renderCalendar();
}, 350);

/* ================= Rename / move / create / delete ================= */
const cleanName = (s) => s.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim();
async function commitTitle(pane) {
  const n = pane.note; if (!n) return;
  const name = cleanName(pane.titleEl.value);
  if (!name) { pane.titleEl.value = n.name; return; }
  if (name === n.name) return;
  const target = (n.folder ? n.folder + '/' : '') + name + '.md';
  if (S.notes.has(target) && target.toLowerCase() !== n.path.toLowerCase()) {
    toast(`"${name}" already exists`, true); pane.titleEl.value = n.name; return;
  }
  await movePath(n.path, target);
}
async function movePath(oldPath, newPath) {
  await flushAll();
  const affected = [];
  for (const n of S.notes.values()) {
    const targets = new Set(n.links.filter((l) => resolve(l.target) === oldPath).map((l) => l.target.toLowerCase()));
    if (targets.size) affected.push({ n, targets });
  }
  let finalPath;
  try { finalPath = await loom.renameNote(oldPath, newPath); }
  catch (err) {
    toast(err.message.replace(/^.*Error: /, ''), true);
    S.panes.forEach((p) => { if (p.note) p.titleEl.value = p.note.name; });
    return;
  }
  const note = S.notes.get(oldPath);
  S.notes.delete(oldPath);
  note.path = finalPath; setMeta(note);
  S.notes.set(finalPath, note);
  rebuildIndex();
  const text = linkTextFor(finalPath);
  let updated = 0;
  for (const { n, targets } of affected) {
    const next = n.content.replace(WIKI_PARTS, (m, t, h = '', a = '') => (targets.has(t.trim().toLowerCase()) ? `[[${text}${h}${a}]]` : m));
    if (next !== n.content) { n.content = next; parseNote(n); updated++; await loom.writeNote(n.path, next); }
  }
  const swap = (p) => (p === oldPath ? finalPath : p);
  for (const p of S.panes) {
    for (const t of p.tabs) { t.path = swap(t.path); t.back = t.back.map(swap); t.fwd = t.fwd.map(swap); }
    p.refreshContent();
  }
  if (store.get('last:' + S.vault.path) === oldPath) store.set('last:' + S.vault.path, finalPath);
  renderTree(); markActiveInTree(); renderRight(); refreshEditors(); saveWorkspace(); updateLocalGraph();
  if (S.view === 'graph') refreshGraph();
  if (updated) toast(`Updated links in ${updated} note${updated > 1 ? 's' : ''}`);
}
async function newNote(folder, name = 'Untitled', content = '', { newTab = true, pane } = {}) {
  if (folder == null) folder = cur() ? cur().folder : '';
  await flushAll();
  const path = await loom.createNote((folder ? folder + '/' : '') + name + '.md', content);
  await loadNotes(); renderTree(); renderTags(); renderCalendar(); refreshEditors();
  const p = pane || S.active;
  await openNote(path, { newTab: newTab && !!p.path, pane: p });
  if (p.tab) p.setMode('edit');
  if (name === 'Untitled') { p.titleEl.focus(); p.titleEl.select(); }
  else p.editor.focus();
  return path;
}
async function newFolder(parent = '') {
  const name = await promptDialog('New folder', 'Folder name', '');
  if (!name || !cleanName(name)) return;
  const p = (parent ? parent + '/' : '') + cleanName(name);
  await loom.createFolder(p);
  await loadNotes(); S.expanded.add(p); if (parent) S.expanded.add(parent); saveExpanded(); renderTree();
}
async function deleteNote(path) {
  const n = S.notes.get(path); if (!n) return;
  const bl = backlinksOf(path).length;
  const ok = await confirmDialog(`Delete "${n.name}"?`,
    `It will be moved to your system trash.${bl ? ` ${bl} note${bl > 1 ? 's' : ''} link here and will show an unresolved link.` : ''}`, 'Delete');
  if (!ok) return;
  clearTimeout(S.timers.get(path)); S.dirty.delete(path);
  await loom.deleteNote(path);
  S.notes.delete(path); rebuildIndex();
  for (const p of [...S.panes]) {
    for (const t of p.tabs) { t.back = t.back.filter((x) => x !== path); t.fwd = t.fwd.filter((x) => x !== path); }
    for (let i = p.tabs.length - 1; i >= 0; i--) if (p.tabs[i].path === path) p.closeTab(i);
  }
  renderTree(); renderTags(); renderRight(); renderCalendar(); refreshEditors(); updateLocalGraph();
  if (S.view === 'graph') refreshGraph();
}
async function renameDialog(path) {
  const n = S.notes.get(path); if (!n) return;
  const name = await promptDialog('Rename note', 'Links pointing to this note will be updated.', n.name);
  if (!name || cleanName(name) === n.name) return;
  await movePath(path, (n.folder ? n.folder + '/' : '') + cleanName(name) + '.md');
}
async function openOrCreate(target, { newTab = false, pane } = {}) {
  const p = resolve(target);
  if (p) return openNote(p, { newTab, pane });
  const parts = target.split('/').map(cleanName).filter(Boolean);
  const name = parts.pop();
  if (!name) return;
  return newNote(parts.join('/'), name, '', { newTab, pane });
}
function linkOptions(q, exclude) {
  const items = rankNotes(q, 8, exclude).map((n) => ({ label: n.name, detail: n.folder, text: linkTextFor(n.path) }));
  if (q.trim() && !resolve(q)) items.push({ label: q.trim(), detail: 'New note', text: q.trim(), create: true });
  return items;
}
function openUrl(href) {
  if (/^(https?:|mailto:)/i.test(href)) window.open(href);
  else if (!href.startsWith('#')) openOrCreate(decodeURI(href).replace(/\.md$/i, ''));
}
function imageUrl(href, folder) {
  if (/^(https?:|data:|file:|blob:)/i.test(href) || !S.vault) return href;
  const base = S.vault.path.replace(/\\/g, '/') + '/' + (folder ? folder + '/' : '');
  return 'file:///' + encodeURI(base + decodeURI(href)).replace(/#/g, '%23');
}

/* ================= Reader (markdown rendering) ================= */
let renderFolder_ = '';
marked.use({
  gfm: true,
  walkTokens(t) { if (t.type === 'image' && t.href) t.href = imageUrl(t.href, renderFolder_); },
  extensions: [
    {
      name: 'wikilink', level: 'inline',
      start(src) { const i = src.indexOf('[['); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^\[\[([^[\]\n]+?)\]\]/.exec(src);
        if (!m) return;
        const [tp, alias] = m[1].split('|');
        return { type: 'wikilink', raw: m[0], target: tp.split('#')[0].trim(), text: (alias || tp).trim() };
      },
      renderer(t) { return `<a class="wikilink${resolve(t.target) ? '' : ' missing'}" data-target="${esc(t.target)}">${esc(t.text)}</a>`; },
    },
    {
      name: 'tag', level: 'inline',
      start(src) { const m = /(^|[\s(])#[A-Za-z]/.exec(src); return m ? m.index + m[1].length : undefined; },
      tokenizer(src) { const m = /^#([A-Za-z][\w\-/]*)/.exec(src); if (m) return { type: 'tag', raw: m[0], tag: m[1] }; },
      renderer(t) { return `<span class="tag" data-tag="${esc(t.tag.toLowerCase())}">#${esc(t.tag)}</span>`; },
    },
  ],
});
function renderMarkdown(content, folder) {
  renderFolder_ = folder || '';
  return marked.parse(content || '');
}
function renderReader(pane) {
  const n = pane.note; if (!n) return;
  pane.reader.innerHTML = renderMarkdown(n.content || '*Empty note*', n.folder);
  $$('input[type=checkbox]', pane.reader).forEach((cb, i) => { cb.disabled = false; cb.dataset.idx = i; });
}
function readerClick(e, pane) {
  const wl = e.target.closest('.wikilink');
  if (wl) { e.preventDefault(); openOrCreate(wl.dataset.target, { newTab: e.ctrlKey || e.metaKey, pane }); return; }
  const a = e.target.closest('a[href]');
  if (a) { e.preventDefault(); openUrl(a.getAttribute('href')); return; }
  const tg = e.target.closest('.tag');
  if (tg) { searchFor('#' + tg.dataset.tag); return; }
  const cb = e.target.closest('input[type=checkbox]');
  if (cb) {
    const n = pane.note; let i = 0; const idx = Number(cb.dataset.idx);
    n.content = n.content.replace(/^(\s*[-*+]\s+\[)([ xX])(\])/gm, (m, x, y, z) => (i++ === idx ? x + (y === ' ' ? 'x' : ' ') + z : m));
    parseNote(n); markDirty(n.path);
    for (const p of S.panes) if (p.path === n.path && p !== pane) p.refreshContent();
    pane.loading = true; pane.editor.setDoc(n.content); pane.loading = false;
  }
}
function toggleMode() {
  const p = S.active; if (!p.tab || !p.path) return;
  p.setMode(p.tab.mode === 'edit' ? 'read' : 'edit');
}

/* ================= Right panel & local graph ================= */
function renderRight() {
  const box = $('#rp-content');
  const n = cur();
  $('#lg-wrap').classList.toggle('hidden', !n);
  if (!n) { box.innerHTML = '<div class="empty-hint" style="margin-top:40px">Open a note to see its connections.</div>'; return; }
  const bl = backlinksOf(n.path);
  const hl = (line) => esc(line).replace(WIKI_RE, (m, inner) => `<b>${(inner.split('|')[1] || inner.split('|')[0])}</b>`);
  let h = `<div class="rp-sec"><div class="rp-head">${icon('backlink', 14)} Backlinks <span class="count">${bl.length}</span></div>`;
  h += bl.length
    ? bl.map(({ note, lines }) => `<div class="bl-item" data-open="${esc(note.path)}"><div class="bl-title">${esc(note.name)}</div>${lines.slice(0, 2).map((l) => `<div class="bl-ctx">${hl(l)}</div>`).join('')}</div>`).join('')
    : '<div class="empty-hint">No notes link here yet.</div>';
  h += '</div>';
  const seen = new Set();
  const out = n.links.filter((l) => { const k = l.target.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  h += `<div class="rp-sec"><div class="rp-head">${icon('link', 14)} Outgoing <span class="count">${out.length}</span></div>`;
  h += out.length
    ? out.map((l) => { const p = resolve(l.target); return `<div class="link-row ${p ? '' : 'missing'}" data-target="${esc(l.target)}" title="${p ? '' : 'Not created yet — click to create'}">${icon(p ? 'doc' : 'plus', 14)}${esc(p ? S.notes.get(p).name : l.target)}</div>`; }).join('')
    : '<div class="empty-hint">Type [[ to link another note.</div>';
  h += '</div>';
  if (n.tags.size) h += `<div class="rp-sec"><div class="rp-head">${icon('hash', 14)} Tags</div><div class="chips">${[...n.tags].map((t) => `<span class="chip" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}</div></div>`;
  const heads = [];
  stripCode(n.content).split('\n').forEach((line, i) => { const m = /^(#{1,4})\s+(.+)/.exec(line); if (m) heads.push({ lvl: m[1].length, text: m[2], line: i }); });
  if (heads.length) h += `<div class="rp-sec"><div class="rp-head">${icon('list', 14)} Outline</div>${heads.map((x, i) => `<button class="outline-row" data-line="${x.line}" data-hidx="${i}" style="padding-left:${10 + (x.lvl - 1) * 12}px">${esc(x.text)}</button>`).join('')}</div>`;
  box.innerHTML = h;
}
$('#rp-content').addEventListener('click', (e) => {
  const nt = e.ctrlKey || e.metaKey;
  const o = e.target.closest('[data-open]'); if (o) return openNote(o.dataset.open, { newTab: nt });
  const l = e.target.closest('[data-target]'); if (l) return openOrCreate(l.dataset.target, { newTab: nt });
  const t = e.target.closest('[data-tag]'); if (t) return searchFor('#' + t.dataset.tag);
  const h = e.target.closest('[data-line]');
  if (h) {
    const p = S.active;
    if (p.tab.mode === 'read') { $$('h1,h2,h3,h4', p.reader)[Number(h.dataset.hidx)]?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    p.editor.scrollToLine(Number(h.dataset.line) + 1);
  }
});
$('#rp-content').addEventListener('mouseover', (e) => {
  const o = e.target.closest('[data-open], .link-row[data-target]');
  if (o) hoverLink(o.dataset.open ? S.notes.get(o.dataset.open)?.name || '' : o.dataset.target, o, e, false, o.dataset.open);
});
function toggleRight() {
  document.body.classList.toggle('no-right');
  store.set('noRight', document.body.classList.contains('no-right'));
  updateLocalGraph();
}

function localGraphData(center, depth) {
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set()); adj.get(a).add(b); adj.get(b).add(a); };
  for (const n of S.notes.values()) for (const l of n.links) {
    const p = resolve(l.target);
    add(n.path, p || 'ghost:' + l.target.toLowerCase());
  }
  const dist = new Map([[center, 0]]);
  const queue = [center];
  while (queue.length) {
    const x = queue.shift(); const d = dist.get(x);
    if (d >= depth) continue;
    for (const y of adj.get(x) || []) if (!dist.has(y)) { dist.set(y, d + 1); queue.push(y); }
  }
  const tops = [...new Set([...S.notes.values()].map((n) => n.folder.split('/')[0]).filter(Boolean))].sort();
  const nodes = [...dist.keys()].map((id) => {
    if (id.startsWith('ghost:')) return { id, label: id.slice(6), type: 'ghost' };
    const n = S.notes.get(id); const g = n.folder.split('/')[0];
    return { id, label: n.name, type: 'note', group: g, groupIndex: tops.indexOf(g) };
  });
  const links = [];
  const seen = new Set();
  for (const a of dist.keys()) for (const b of adj.get(a) || []) {
    if (!dist.has(b)) continue;
    const k = a < b ? a + '\0' + b : b + '\0' + a;
    if (!seen.has(k)) { seen.add(k); links.push({ source: a, target: b }); }
  }
  return { nodes, links };
}
let lgCenter = null;
function updateLocalGraph() {
  const n = cur();
  const visible = n && !document.body.classList.contains('no-right') && !document.body.classList.contains('focus');
  if (!visible) { if (S.lg) S.lg.stop(); return; }
  if (!S.lg) {
    S.lg = new Graph($('#lg-canvas'), {
      mini: true,
      onOpen: (node, e) => {
        if (node.type === 'note') openNote(node.id, { newTab: e && (e.ctrlKey || e.metaKey) });
        else if (node.type === 'ghost') openOrCreate(node.label);
      },
    });
  }
  S.lg.start();
  const { nodes, links } = localGraphData(n.path, S.lgDepth);
  S.lg.setData(nodes, links);
  S.lg.setCurrent(n.path);
  if (lgCenter !== n.path) {
    lgCenter = n.path;
    S.lg.requestFit();
    setTimeout(() => S.lg.fit(true), 300);
  }
}
$('#lg-depth').addEventListener('click', (e) => {
  const b = e.target.closest('[data-d]'); if (!b) return;
  S.lgDepth = Number(b.dataset.d); store.set('lgDepth', S.lgDepth);
  $$('#lg-depth button').forEach((x) => x.classList.toggle('on', x === b));
  lgCenter = null; updateLocalGraph();
});
$('#lg-open').onclick = () => showGraph(true);

function renderStatus() {
  const n = cur();
  if (!n) { $('#st-words').textContent = ''; $('#st-links').textContent = ''; setSaveStatus(); return; }
  const words = (n.content.match(/\S+/g) || []).length;
  $('#st-words').textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'} · ${n.content.length.toLocaleString()} chars`;
  const bl = backlinksOf(n.path).length;
  $('#st-links').textContent = `${n.links.length} link${n.links.length === 1 ? '' : 's'} · ${bl} backlink${bl === 1 ? '' : 's'}`;
  setSaveStatus();
}

/* ================= Sidebar: panels, search, tags ================= */
function toggleSidebar(force) {
  const hide = force != null ? force : !document.body.classList.contains('no-sidebar');
  document.body.classList.toggle('no-sidebar', hide);
  $('#tb-sidebar').classList.toggle('on', !hide);
  $$('#ribbon [data-panel]').forEach((b) => b.classList.toggle('active', !hide && b.dataset.panel === S.panel));
  store.set('noSidebar', hide);
}
function showPanel(name) {
  S.panel = name;
  toggleSidebar(false);
  $$('#sidebar .panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  if (name === 'search') setTimeout(() => $('#search-input').select(), 30);
  if (name === 'tags') renderTags();
  if (name === 'calendar') renderCalendar();
}
$('#ribbon').addEventListener('click', (e) => {
  const b = e.target.closest('[data-panel]'); if (!b) return;
  // Clicking the panel that's already showing collapses the sidebar; clicking again brings it back.
  if (S.panel === b.dataset.panel && !document.body.classList.contains('no-sidebar')) toggleSidebar(true);
  else showPanel(b.dataset.panel);
});
$('#tb-sidebar').onclick = () => toggleSidebar();
function searchFor(q) { if (S.view === 'graph') showGraph(false); showPanel('search'); $('#search-input').value = q; runSearch(); }

function runSearch() {
  const q = $('#search-input').value.trim();
  const box = $('#search-results');
  if (!q) { box.innerHTML = '<div class="empty-hint">Search titles and content.<br>Start with # to filter by tag.</div>'; return; }
  let results = [];
  if (/^(#|tag:)/i.test(q)) {
    const tag = q.replace(/^(#|tag:)/i, '').toLowerCase();
    results = [...S.notes.values()].filter((n) => [...n.tags].some((t) => t === tag || t.startsWith(tag + '/'))).map((n) => ({ n, lines: [] }));
  } else {
    const terms = q.toLowerCase().split(/\s+/);
    for (const n of S.notes.values()) {
      const hay = (n.name + '\n' + n.content).toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      const lines = n.content.split('\n').filter((l) => terms.some((t) => l.toLowerCase().includes(t))).slice(0, 3);
      results.push({ n, lines, score: terms.filter((t) => n.name.toLowerCase().includes(t)).length * 10 + lines.length });
    }
    results.sort((a, b) => b.score - a.score);
  }
  const terms = q.replace(/^(#|tag:)/i, '').split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = terms.length ? new RegExp(`(${terms.join('|')})`, 'gi') : null;
  const mark = (s) => (re ? esc(s).replace(re, '<mark>$1</mark>') : esc(s));
  box.innerHTML = results.length
    ? `<div class="empty-hint" style="text-align:left;padding:4px 10px 8px">${results.length} result${results.length > 1 ? 's' : ''}</div>` +
      results.slice(0, 150).map(({ n, lines }) => `<div class="sr-note" data-open="${esc(n.path)}">
        <div class="sr-title">${mark(n.name)} ${n.folder ? `<span class="muted">${esc(n.folder)}</span>` : ''}</div>
        ${lines.map((l) => `<div class="sr-line">${mark(l.trim())}</div>`).join('')}</div>`).join('')
    : '<div class="empty-hint">No matches.</div>';
}
$('#search-input').addEventListener('input', debounce(runSearch, 120));
$('#search-results').addEventListener('click', (e) => { const r = e.target.closest('[data-open]'); if (r) openNote(r.dataset.open, { newTab: e.ctrlKey || e.metaKey }); });

function renderTags() {
  const tags = allTags();
  $('#tag-list').innerHTML = tags.length
    ? tags.map(([t, c]) => `<div class="tag-row" data-tag="${esc(t)}"><span>#${esc(t)}</span><span class="count">${c}</span></div>`).join('')
    : '<div class="empty-hint">No tags yet. Add #something to a note.</div>';
}
$('#tag-list').addEventListener('click', (e) => { const r = e.target.closest('[data-tag]'); if (r) searchFor('#' + r.dataset.tag); });

/* ================= Daily notes & calendar ================= */
const dailyFolder = () => (settings.dailyFolder || '').trim().replace(/^\/+|\/+$/g, '');
const dailyPath = (d) => (dailyFolder() ? dailyFolder() + '/' : '') + dayKey(d) + '.md';
async function openDaily(date = new Date(), { newTab = false } = {}) {
  const path = dailyPath(date);
  if (S.notes.has(path)) return openNote(path, { newTab });
  const title = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  await newNote(dailyFolder(), dayKey(date), `# ${title}\n\n- `, { newTab });
  const p = S.active; p.editor.view.dispatch({ selection: { anchor: p.editor.view.state.doc.length } });
}
function activityByDay() {
  const map = new Map();
  const bump = (ms) => { if (!ms) return; const k = dayKey(new Date(ms)); map.set(k, (map.get(k) || 0) + 1); };
  for (const n of S.notes.values()) {
    bump(created(n));
    if (n.mtime && dayKey(new Date(n.mtime)) !== dayKey(new Date(created(n)))) bump(n.mtime);
  }
  return map;
}
function heatColor(v, max) {
  if (!v) return '';
  const lvl = Math.min(4, Math.ceil((v / Math.max(1, max)) * 4));
  return `background: color-mix(in srgb, var(--accent) ${[0, 28, 48, 70, 92][lvl]}%, var(--heat-0))`;
}
function renderCalendar() {
  if (S.panel !== 'calendar' || !S.vault) return;
  const act = activityByDay();
  const max = Math.max(1, ...act.values());
  const dailies = new Set([...S.notes.keys()].filter((p) => p.startsWith(dailyFolder() ? dailyFolder() + '/' : '') && /\d{4}-\d{2}-\d{2}\.md$/.test(p)).map((p) => p.slice(-13, -3)));
  const m = S.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const today = dayKey(new Date());
  let grid = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (i >= 35 && d.getMonth() !== m.getMonth()) break;
    const k = dayKey(d), v = act.get(k) || 0;
    const cls = ['cal-day', d.getMonth() !== m.getMonth() && 'out', k === today && 'today', dailies.has(k) && 'has-note'].filter(Boolean).join(' ');
    const tip = `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${v} note${v === 1 ? '' : 's'} touched${dailies.has(k) ? ' · daily note' : ''}`;
    grid += `<div class="${cls}" data-day="${k}" title="${tip}" style="${d.getMonth() === m.getMonth() ? heatColor(v, max) : ''}">${d.getDate()}</div>`;
  }
  // 20-week activity heatmap ending this week
  const weeks = 20;
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const hmStart = new Date(end); hmStart.setDate(end.getDate() - ((end.getDay() + 6) % 7) - (weeks - 1) * 7);
  let hm = '', total = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(hmStart); d.setDate(hmStart.getDate() + i);
    if (d > end) { hm += '<div class="heat" style="visibility:hidden"></div>'; continue; }
    const k = dayKey(d), v = act.get(k) || 0; total += v;
    hm += `<div class="heat" data-day="${k}" title="${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${v}" style="${heatColor(v, max)}"></div>`;
  }
  let streak = 0;
  for (const d = new Date(end); act.get(dayKey(d)); d.setDate(d.getDate() - 1)) streak++;
  const monthCreated = [...S.notes.values()].filter((n) => { const c = new Date(created(n)); return c.getMonth() === m.getMonth() && c.getFullYear() === m.getFullYear(); }).length;
  $('#calendar').innerHTML = `
    <div class="cal-head">
      <button class="icon-btn sm" data-cal="-1">${icon('chevLeft', 15)}</button>
      <span class="cal-month">${m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
      <button class="icon-btn sm" data-cal="1">${icon('chev', 15)}</button>
    </div>
    <div class="cal-grid">${grid}</div>
    <div class="cal-section"><h4>Activity <span>${weeks} weeks</span></h4><div class="heatmap">${hm}</div>
      <div class="heat-legend">Less ${[0, 1, 2, 3, 4].map((l) => `<div class="heat" style="${l ? heatColor(l, 4) : ''}"></div>`).join('')} More</div></div>
    <div class="cal-section"><h4>Stats</h4><div class="cal-stats">
      <div class="cal-stat"><b>${monthCreated}</b><span>new this month</span></div>
      <div class="cal-stat"><b>${streak}</b><span>day streak</span></div>
      <div class="cal-stat"><b>${dailies.size}</b><span>daily notes</span></div>
      <div class="cal-stat"><b>${S.notes.size}</b><span>notes total</span></div>
    </div></div>`;
}
$('#calendar').addEventListener('click', (e) => {
  const nav = e.target.closest('[data-cal]');
  if (nav) { S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + Number(nav.dataset.cal), 1); renderCalendar(); return; }
  const d = e.target.closest('[data-day]');
  if (d) { const [y, mo, da] = d.dataset.day.split('-').map(Number); openDaily(new Date(y, mo - 1, da), { newTab: e.ctrlKey || e.metaKey }); }
});
$('#cal-today').onclick = () => { const d = new Date(); S.calMonth = new Date(d.getFullYear(), d.getMonth(), 1); renderCalendar(); };

/* ================= Hover previews ================= */
let hoverTimer = null, hideTimer = null;
function hoverLink(target, anchor, e, needCtrl, path) {
  if (needCtrl && !(e.ctrlKey || e.metaKey)) return;
  clearTimeout(hideTimer); clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => showHover(path || resolve(target), target, anchor), needCtrl ? 60 : 500);
  anchor.addEventListener('mouseleave', hoverEnd, { once: true });
}
function showHover(path, target, anchor) {
  if (!anchor.isConnected) return;
  const n = path && S.notes.get(path);
  const card = el.hover;
  card.innerHTML = `<div class="hc-head">${icon('doc', 14)}<span>${esc(n ? n.name : target)}</span><span class="muted">${esc(n ? n.folder : 'not created yet')}</span></div>
    <div class="hc-body">${n ? (n.content.trim() ? `<div class="md">${renderMarkdown(n.content.slice(0, 4000), n.folder)}</div>` : '<div class="hc-empty">Empty note</div>') : '<div class="hc-empty">Click the link to create this note.</div>'}</div>`;
  card.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  if (anchor.closest('#rightpanel')) {
    // Links in the side panel: open the preview beside the panel instead of over it.
    card.style.left = Math.max(8, r.left - w - 14) + 'px';
    card.style.top = Math.max(8, Math.min(r.top - 24, innerHeight - h - 12)) + 'px';
    return;
  }
  card.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 12)) + 'px';
  card.style.top = (r.bottom + h + 12 > innerHeight ? Math.max(8, r.top - h - 8) : r.bottom + 8) + 'px';
}
function hoverEnd() { clearTimeout(hoverTimer); clearTimeout(hideTimer); hideTimer = setTimeout(() => el.hover.classList.add('hidden'), 220); }
el.hover.addEventListener('mouseenter', () => clearTimeout(hideTimer));
el.hover.addEventListener('mouseleave', hoverEnd);
el.hover.addEventListener('click', (e) => {
  const wl = e.target.closest('.wikilink');
  if (wl) { el.hover.classList.add('hidden'); openOrCreate(wl.dataset.target, { newTab: e.ctrlKey || e.metaKey }); }
  const a = e.target.closest('a[href]'); if (a) { e.preventDefault(); openUrl(a.getAttribute('href')); }
});

/* ================= Quick switcher & command palette ================= */
function fuzzy(q, s) {
  if (!q) return 1;
  q = q.toLowerCase(); s = s.toLowerCase();
  const i = s.indexOf(q);
  if (i >= 0) return 100 - i - (s.length - q.length) * 0.1 + (i === 0 ? 50 : 0);
  let si = 0, score = 0, run = 0;
  for (const ch of q) {
    const f = s.indexOf(ch, si);
    if (f < 0) return -1;
    run = f === si ? run + 1 : 0;
    score += 1 + run * 2 - Math.min(f - si, 5) * 0.2;
    si = f + 1;
  }
  return score;
}
function rankNotes(q, limit = 50, exclude) {
  return [...S.notes.values()]
    .filter((n) => n.path !== exclude)
    .map((n) => ({ n, s: Math.max(fuzzy(q, n.name), fuzzy(q, n.path) - 5) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || b.n.mtime - a.n.mtime)
    .slice(0, limit).map((x) => x.n);
}
function pushRecent(path) {
  const k = 'recent:' + S.vault.path;
  store.set(k, [path, ...store.get(k, []).filter((p) => p !== path)].slice(0, 20));
}

// Generic list picker used by both the switcher and the palette.
function picker({ placeholder, items, render, choose, footer }) {
  const back = modal(`<div class="modal">
    <div class="qs-input">${icon('search', 18)}<input placeholder="${esc(placeholder)}" spellcheck="false" /></div>
    <div class="qs-list"></div><div class="qs-foot">${footer}</div></div>`);
  const input = $('input', back), list = $('.qs-list', back);
  let rows = [], sel = 0;
  const draw = () => {
    rows = items(input.value.trim());
    sel = Math.min(sel, Math.max(0, rows.length - 1));
    list.innerHTML = rows.map((r, i) => `<div class="qs-item ${i === sel ? 'sel' : ''}" data-i="${i}">${render(r)}</div>`).join('') || '<div class="empty-hint">Nothing found.</div>';
  };
  const go = (i, e) => { const r = rows[i]; back.remove(); if (r) choose(r, e, input.value.trim()); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length); draw();
      $('.qs-item.sel', list)?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter') { e.preventDefault(); go(sel, e); }
  });
  list.addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) go(Number(r.dataset.i), e); });
  draw(); input.focus();
}
function openSwitcher() {
  const recent = store.get('recent:' + S.vault.path, []).filter((p) => S.notes.has(p));
  picker({
    placeholder: 'Find or create a note…',
    footer: '<span><kbd>↑↓</kbd> navigate</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl Enter</kbd> new tab</span><span><kbd>Shift Enter</kbd> create</span>',
    items: (q) => {
      const notes = q ? rankNotes(q, 40) : [...recent.map((p) => S.notes.get(p)), ...[...S.notes.values()].filter((n) => !recent.includes(n.path)).sort((a, b) => b.mtime - a.mtime)].slice(0, 40);
      const rows = notes.map((n) => ({ n }));
      if (q && !resolve(q)) rows.push({ create: q });
      return rows;
    },
    render: (r) => (r.create ? `${icon('plus', 16)}<span>Create “${esc(r.create)}”</span>` : `${icon('doc', 16)}<span>${esc(r.n.name)}</span><span class="qs-path">${esc(r.n.folder)}</span>`),
    choose: (r, e, q) => {
      const newTab = e.ctrlKey || e.metaKey;
      if (e.shiftKey && q) return openOrCreate(q, { newTab });
      if (r.create) openOrCreate(r.create, { newTab }); else openNote(r.n.path, { newTab });
    },
  });
}
function commands() {
  const has = !!cur();
  return [
    { name: 'New note', key: 'Ctrl N', icon: 'plus', run: () => newNote() },
    { name: 'Open today’s daily note', key: 'Ctrl Shift D', icon: 'sun', run: () => openDaily() },
    { name: 'Quick switcher: open a note', key: 'Ctrl O', icon: 'search', run: openSwitcher },
    { name: 'Search all notes', key: 'Ctrl Shift F', icon: 'search', run: () => showPanel('search') },
    { name: 'Open graph view', key: 'Ctrl G', icon: 'graph', run: () => showGraph(true) },
    { name: 'Graph: play time-lapse', icon: 'play', run: () => { showGraph(true); setTimeout(startTimelapse, 400); } },
    { name: 'Graph: export as PNG image', icon: 'image', run: () => { showGraph(true); setTimeout(exportPng, 900); } },
    { name: 'Graph: export as web page', icon: 'globe', run: () => { showGraph(true); setTimeout(exportHtml, 900); } },
    { name: 'New tab', key: 'Ctrl T', icon: 'plus', run: () => S.active.newTab() },
    { name: 'Close tab', key: 'Ctrl W', icon: 'x', run: () => S.active.closeTab(S.active.idx) },
    { name: 'Split right', icon: 'split', run: splitRight },
    has && { name: 'Toggle reading / editing', key: 'Ctrl E', icon: 'eye', run: toggleMode },
    has && { name: 'Rename current note', icon: 'edit', run: () => renameDialog(curPath()) },
    has && { name: 'Delete current note', icon: 'trash', run: () => deleteNote(curPath()) },
    has && { name: 'Toggle checkbox on current line', key: 'Ctrl Enter', icon: 'check', run: () => S.active.editor.toggleTask() },
    { name: 'Toggle focus mode', key: 'Ctrl Shift Enter', icon: 'focus', run: toggleFocus },
    { name: 'Toggle typewriter scrolling', icon: 'type', run: () => setSetting('typewriter', !settings.typewriter, true) },
    { name: 'Toggle live preview', icon: 'pen', run: () => setSetting('livePreview', !settings.livePreview, true) },
    { name: 'Toggle sidebar', key: 'Ctrl \\', icon: 'panelLeft', run: () => toggleSidebar() },
    { name: 'Toggle info panel', icon: 'panelRight', run: toggleRight },
    { name: 'Show calendar', icon: 'calendar', run: () => showPanel('calendar') },
    { name: 'Switch light / dark', key: 'Ctrl Shift L', icon: 'moon', run: toggleTheme },
    ...THEMES.map((t) => ({ name: `Theme: ${t.name}`, icon: 'sparkle', run: () => setTheme(t.id) })),
    { name: 'Open settings', key: 'Ctrl ,', icon: 'gear', run: openSettings },
    { name: 'Open another vault…', icon: 'vault', run: switchVault },
    { name: 'Show vault folder', icon: 'external', run: () => loom.revealVault() },
  ].filter(Boolean);
}
function openPalette() {
  picker({
    placeholder: 'Type a command…',
    footer: '<span><kbd>↑↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span>',
    items: (q) => commands().map((c) => ({ c, s: fuzzy(q, c.name) })).filter((x) => x.s >= 0).sort((a, b) => (q ? b.s - a.s : 0)).map((x) => x.c),
    render: (c) => `${icon(c.icon || 'command', 16)}<span>${esc(c.name)}</span>${c.key ? `<span class="qs-path"><kbd>${esc(c.key)}</kbd></span>` : ''}`,
    choose: (c) => c.run(),
  });
}

/* ================= Modals, menus, toasts ================= */
function modal(html) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = html;
  back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); back.remove(); } });
  el.modal.appendChild(back);
  return back;
}
function promptDialog(title, text, value) {
  return new Promise((res) => {
    const back = modal(`<div class="modal dialog" style="width:420px"><h3>${esc(title)}</h3><p>${esc(text)}</p>
      <input value="${esc(value)}" spellcheck="false" /><div class="dialog-actions"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div></div>`);
    const input = $('input', back);
    const done = (v) => { back.remove(); res(v); };
    $('[data-x]', back).onclick = () => done(null);
    $('[data-ok]', back).onclick = () => done(input.value.trim());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim()); });
    new MutationObserver((_, o) => { if (!back.isConnected) { o.disconnect(); res(null); } }).observe(el.modal, { childList: true });
    input.focus(); input.select();
  });
}
function confirmDialog(title, text, okLabel = 'OK') {
  return new Promise((res) => {
    const back = modal(`<div class="modal dialog" style="width:420px"><h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="dialog-actions"><button class="btn" data-x>Cancel</button><button class="btn danger" data-ok>${esc(okLabel)}</button></div></div>`);
    const done = (v) => { back.remove(); res(v); };
    $('[data-x]', back).onclick = () => done(false);
    $('[data-ok]', back).onclick = () => done(true);
    new MutationObserver((_, o) => { if (!back.isConnected) { o.disconnect(); res(false); } }).observe(el.modal, { childList: true });
    $('[data-ok]', back).focus();
  });
}
function showMenu(x, y, items) {
  el.ctx.innerHTML = items.map((it, i) => (it === '-' ? '<div class="ctx-sep"></div>'
    : `<div class="ctx-item ${it.danger ? 'danger' : ''}" data-i="${i}">${icon(it.icon || 'doc', 14)}${esc(it.label)}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</div>`)).join('');
  el.ctx.classList.remove('hidden');
  el.ctx.style.left = Math.max(8, Math.min(x, innerWidth - el.ctx.offsetWidth - 8)) + 'px';
  el.ctx.style.top = Math.min(y, innerHeight - el.ctx.offsetHeight - 8) + 'px';
  el.ctx.onclick = (e) => { const r = e.target.closest('[data-i]'); if (!r) return; el.ctx.classList.add('hidden'); items[Number(r.dataset.i)].run(); };
}
document.addEventListener('mousedown', (e) => { if (!el.ctx.contains(e.target)) el.ctx.classList.add('hidden'); });
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2600);
}

/* ================= Graph view ================= */
function graphData() {
  const o = S.gopts;
  const nodes = new Map(), links = [], seen = new Set();
  const tops = [...new Set([...S.notes.values()].map((n) => n.folder.split('/')[0]).filter(Boolean))].sort();
  for (const n of S.notes.values()) {
    const g = n.folder.split('/')[0];
    nodes.set(n.path, { id: n.path, label: n.name, type: 'note', group: g, groupIndex: tops.indexOf(g) });
  }
  const addLink = (a, b, kind) => {
    const k = a < b ? a + '\0' + b : b + '\0' + a;
    if (seen.has(k)) return; seen.add(k);
    links.push({ source: a, target: b, kind });
  };
  for (const n of S.notes.values()) {
    for (const l of n.links) {
      const p = resolve(l.target);
      if (p) addLink(n.path, p, 'link');
      else if (o.ghosts) {
        const id = 'ghost:' + l.target.toLowerCase();
        if (!nodes.has(id)) nodes.set(id, { id, label: l.target, type: 'ghost' });
        addLink(n.path, id, 'link');
      }
    }
    if (o.tags) for (const t of n.tags) {
      const id = 'tag:' + t;
      if (!nodes.has(id)) nodes.set(id, { id, label: '#' + t, type: 'tag' });
      addLink(n.path, id, 'tag');
    }
  }
  let list = [...nodes.values()];
  if (o.filter) { const f = o.filter.toLowerCase(); list = list.filter((n) => n.label.toLowerCase().includes(f)); }
  const keep = new Set(list.map((n) => n.id));
  const ls = links.filter((l) => keep.has(l.source) && keep.has(l.target));
  if (!o.orphans) { const linked = new Set(ls.flatMap((l) => [l.source, l.target])); list = list.filter((n) => linked.has(n.id)); }
  return { nodes: list, links: ls };
}
function refreshGraph() {
  const { nodes, links } = graphData();
  S.graph.setData(nodes, links);
  S.graph.setCurrent(curPath());
  $('#graph-count').textContent = `${nodes.length} nodes · ${links.length} links`;
}
function showGraph(on = S.view !== 'graph') {
  if (!on && TL) stopTimelapse();
  S.view = on ? 'graph' : 'editor';
  document.body.classList.toggle('graph-mode', on);
  $('#graph-view').classList.toggle('hidden', !on);
  $('#rb-graph').classList.toggle('active', on);
  if (on) {
    flushAll();
    if (!S.graph) {
      S.graph = new Graph($('#graph-canvas'), { onOpen: graphOpen, onHover: graphHover });
      Object.defineProperty(S.graph, 'fitInset', { get: panelInset });
      for (const [k, v] of Object.entries(store.get('graph', {}))) applyGraphSetting(k, v, false);
    }
    S.graph.start();
    refreshGraph();
  } else {
    if (S.graph) S.graph.stop();
    $('#graph-tip').classList.add('hidden');
  }
}
async function graphOpen(node, e) {
  if (TL) return;
  const newTab = e && (e.ctrlKey || e.metaKey);
  if (node.type === 'note') await openNote(node.id, { newTab });
  else if (node.type === 'ghost') await openOrCreate(node.label, { newTab });
  else if (node.type === 'tag') searchFor(node.label);
}
function graphHover(node, x, y) {
  const tip = $('#graph-tip');
  if (!node) { tip.classList.add('hidden'); return; }
  let body = '';
  if (node.type === 'note') {
    const n = S.notes.get(node.id); if (!n) return;
    const bl = backlinksOf(n.path).length;
    const first = n.content.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l && l !== n.name) || '';
    const when = new Date(created(n)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    body = `<b>${esc(n.name)}</b>${n.folder ? esc(n.folder) + ' · ' : ''}${n.links.length} out · ${bl} in · ${when}${first ? `<div style="margin-top:6px;color:var(--text-2)">${esc(first.slice(0, 120))}</div>` : ''}`;
  } else if (node.type === 'ghost') body = `<b>${esc(node.label)}</b>Not created yet — click to create`;
  else body = `<b>${esc(node.label)}</b>Tag · click to search`;
  tip.innerHTML = body;
  tip.classList.remove('hidden');
  const r = $('#graph-view').getBoundingClientRect();
  tip.style.left = Math.min(x - r.left + 16, r.width - tip.offsetWidth - 10) + 'px';
  tip.style.top = Math.min(y - r.top + 16, r.height - tip.offsetHeight - 10) + 'px';
}
function applyGraphSetting(key, val, persist = true) {
  const map = { tags: 'g-tags', ghosts: 'g-ghosts', orphans: 'g-orphans', folders: 'g-folders', arrows: 'g-arrows', size: 'g-size', dist: 'g-dist', repel: 'g-repel', label: 'g-label' };
  const input = $('#' + map[key]); if (!input) return;
  if (input.type === 'checkbox') input.checked = !!val; else input.value = val;
  if (key in S.gopts) S.gopts[key] = val; else S.graph.set(key, val);
  if (persist) { const all = store.get('graph', {}); all[key] = val; store.set('graph', all); }
}
for (const [id, key] of [['g-tags', 'tags'], ['g-ghosts', 'ghosts'], ['g-orphans', 'orphans'], ['g-folders', 'folders'], ['g-arrows', 'arrows']]) {
  $('#' + id).addEventListener('change', (e) => { applyGraphSetting(key, e.target.checked); if (key in S.gopts) refreshGraph(); });
}
for (const [id, key] of [['g-size', 'size'], ['g-dist', 'dist'], ['g-repel', 'repel'], ['g-label', 'label']]) {
  $('#' + id).addEventListener('input', (e) => applyGraphSetting(key, Number(e.target.value)));
}
$('#graph-filter').addEventListener('input', debounce((e) => { S.gopts.filter = e.target.value.trim(); refreshGraph(); }, 150));
$('#g-fit').onclick = () => S.graph.fit(true, panelInset());
$('#gp-toggle').onclick = () => { $('#graph-panel').classList.toggle('collapsed'); store.set('gpCollapsed', $('#graph-panel').classList.contains('collapsed')); };
$('#graph-close').onclick = () => showGraph(false);
$('#rb-graph').onclick = () => showGraph();
const panelInset = () => ($('#graph-panel').classList.contains('collapsed') ? 0 : 250);

/* ---------- time-lapse ---------- */
let TL = null;
function startTimelapse() {
  if (!S.graph || !S.graph.nodes.length) return;
  if (TL) stopTimelapse();
  const g = S.graph;
  for (let i = 0; i < 400 && g.alpha > 0.01; i++) g.step(); // settle the final layout first
  g.fit(true, 0);
  const notes = [...S.notes.values()].sort((a, b) => created(a) - created(b) || a.name.localeCompare(b.name));
  const order = new Map(notes.map((n, i) => [n.path, i]));
  for (const n of g.nodes) {
    if (order.has(n.id)) continue;
    const nbs = [...(g.adj.get(n.id) || [])].map((id) => order.get(id)).filter((x) => x != null);
    order.set(n.id, nbs.length ? Math.min(...nbs) : notes.length);
  }
  const steps = notes.length - 1;
  TL = { order, notes, steps, step: -1, playing: true, acc: 0, last: performance.now(), interval: Math.min(900, Math.max(60, Math.min(24000, Math.max(6000, notes.length * 260)) / Math.max(1, notes.length))) };
  g.freeze(true);
  g.revealUpTo(order, -1);
  $('#tl-range').max = steps;
  $('#timeline').classList.remove('hidden');
  $('#graph-panel').classList.add('hidden');
  $('#g-timelapse').classList.add('hidden');
  setTlPlaying(true);
  requestAnimationFrame(tlTick);
}
function tlTick(now) {
  if (!TL) return;
  if (TL.playing) {
    TL.acc += now - TL.last;
    while (TL.acc >= TL.interval && TL.step < TL.steps) { TL.acc -= TL.interval; tlSet(TL.step + 1); }
    if (TL.step >= TL.steps) setTlPlaying(false);
  }
  TL.last = now;
  requestAnimationFrame(tlTick);
}
function tlSet(step) {
  TL.step = step;
  S.graph.revealUpTo(TL.order, step);
  $('#tl-range').value = Math.max(0, step);
  const n = TL.notes[Math.max(0, step)];
  $('#tl-date').textContent = step < 0 ? 'The beginning' : new Date(created(n)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  $('#tl-count').textContent = `${step + 1} of ${TL.notes.length} notes${step >= 0 ? ' · ' + n.name : ''}`;
}
function setTlPlaying(on) {
  if (!TL) return;
  if (on && TL.step >= TL.steps) { tlSet(-1); TL.acc = 0; }
  TL.playing = on; TL.last = performance.now();
  $('#tl-play').innerHTML = icon(on ? 'pause' : 'play', 18);
}
function stopTimelapse() {
  if (!TL) return;
  TL = null;
  S.graph.freeze(false);
  $('#timeline').classList.add('hidden');
  $('#graph-panel').classList.remove('hidden');
  $('#g-timelapse').classList.remove('hidden');
}
$('#g-timelapse').onclick = startTimelapse;
$('#tl-play').onclick = () => setTlPlaying(!TL.playing);
$('#tl-close').onclick = stopTimelapse;
$('#tl-range').addEventListener('input', (e) => { setTlPlaying(false); tlSet(Number(e.target.value)); });

/* ---------- export ---------- */
async function exportPng() {
  if (!S.graph) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const cv = S.graph.renderImage({ width: 3000, height: 2000, bg });
  const saved = await loom.saveFile({ defaultName: `${S.vault.name} graph.png`, filters: [{ name: 'PNG image', extensions: ['png'] }], dataUrl: cv.toDataURL('image/png') });
  if (saved) toast('Graph image saved');
}
async function exportHtml() {
  if (!S.graph) return;
  const cs = getComputedStyle(document.documentElement);
  const vars = {};
  for (const v of ['--bg', '--surface', '--text', '--muted', '--accent', '--accent-glow', '--tag', '--g-edge', '--g-node', '--g-ghost', '--g-label', '--g1', '--g2', '--g3', '--g4', '--g5', '--g6', '--graph-bg', '--shadow']) vars[v] = cs.getPropertyValue(v).trim();
  const nodes = S.graph.nodes.map((n) => ({ id: n.id.startsWith('ghost:') || n.id.startsWith('tag:') ? n.id : 'n' + S.graph.nodes.indexOf(n), _id: n.id, label: n.label, type: n.type, group: n.group, groupIndex: n.groupIndex, x: Math.round(n.x), y: Math.round(n.y) }));
  const idMap = new Map(nodes.map((n) => [n._id, n.id]));
  const links = S.graph.links.map((l) => ({ source: idMap.get(l.s.id), target: idMap.get(l.t.id), kind: l.kind }));
  nodes.forEach((n) => delete n._id);
  const saved = await loom.exportGraphHtml({ title: S.vault.name, nodes, links, vars });
  if (saved) toast('Web page saved — it contains note titles only, not note contents');
}
$('#g-export-png').onclick = exportPng;
$('#g-export-html').onclick = exportHtml;

/* ================= Themes, accent, settings, focus ================= */
function hexToRgb(h) { const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(h); return m ? m.slice(1).map((x) => parseInt(x, 16)) : null; }
function themeMode(id) { return (THEMES.find((t) => t.id === id) || THEMES[0]).mode; }
function applyAppearance(animate = false) {
  const root = document.documentElement;
  if (animate) { document.body.classList.add('theming'); setTimeout(() => document.body.classList.remove('theming'), 350); }
  root.dataset.theme = settings.theme;
  const rgb = settings.accent && hexToRgb(settings.accent);
  if (rgb) {
    const light = themeMode(settings.theme) === 'light';
    const darker = rgb.map((c) => Math.round(c * 0.86));
    root.style.setProperty('--accent', settings.accent);
    root.style.setProperty('--accent-2', `rgb(${darker.join(',')})`);
    root.style.setProperty('--accent-soft', `rgba(${rgb.join(',')},${light ? 0.11 : 0.14})`);
    root.style.setProperty('--accent-glow', `rgba(${rgb.join(',')},${light ? 0.35 : 0.45})`);
  } else ['--accent', '--accent-2', '--accent-soft', '--accent-glow'].forEach((v) => root.style.removeProperty(v));
  document.body.classList.toggle('font-serif', settings.font === 'serif');
  document.body.classList.toggle('font-mono', settings.font === 'mono');
  document.body.classList.toggle('full-width', !!settings.fullWidth);
  root.style.setProperty('--editor-size', settings.fontSize + 'px');
  root.style.setProperty('--editor-font', settings.font === 'serif' ? 'var(--serif)' : settings.font === 'mono' ? 'var(--mono)' : 'var(--ui-font)');
  $('#rb-theme').innerHTML = icon(themeMode(settings.theme) === 'dark' ? 'sun' : 'moon');
  loom.setTheme({ mode: themeMode(settings.theme), bg: getComputedStyle(root).getPropertyValue('--panel').trim() });
  if (S.graph) S.graph.refreshColors();
  if (S.lg) S.lg.refreshColors();
}
function setTheme(id) {
  settings.theme = id;
  if (themeMode(id) === 'dark') settings.darkTheme = id; else settings.lightTheme = id;
  saveSettings(); applyAppearance(true);
}
function toggleTheme() { setTheme(themeMode(settings.theme) === 'dark' ? settings.lightTheme : settings.darkTheme); }
function setSetting(key, val, announce = false) {
  settings[key] = val; saveSettings();
  if (key === 'livePreview') S.panes.forEach((p) => p.editor.setLivePreview(val));
  if (key === 'typewriter') S.panes.forEach((p) => p.editor.setTypewriter(val));
  if (key === 'dailyFolder') renderCalendar();
  applyAppearance();
  if (announce) toast(`${key === 'livePreview' ? 'Live preview' : 'Typewriter scrolling'} ${val ? 'on' : 'off'}`);
}
$('#rb-theme').onclick = toggleTheme;

function toggleFocus(force) {
  const on = force != null ? force : !document.body.classList.contains('focus');
  document.body.classList.toggle('focus', on);
  $('#rb-focus').classList.toggle('active', on);
  if (on) { if (S.view === 'graph') showGraph(false); toast('Focus mode — press Esc to exit'); S.active.editor.focus(); }
  updateLocalGraph();
}
$('#rb-focus').onclick = () => toggleFocus();

function openSettings(section = 'appearance') {
  const back = modal(`<div class="modal settings">
    <nav class="settings-nav"><h3>Settings</h3>
      <button data-s="appearance">${icon('sparkle', 15)} Appearance</button>
      <button data-s="editor">${icon('pen', 15)} Editor</button>
      <button data-s="daily">${icon('calendar', 15)} Daily notes</button>
      <button data-s="vault">${icon('vault', 15)} Vault</button>
      <button data-s="keys">${icon('command', 15)} Shortcuts</button>
      <button data-s="about">${icon('doc', 15)} About</button>
    </nav><div class="settings-body"></div></div>`);
  const body = $('.settings-body', back);
  const row = (label, sub, control) => `<div class="set-row"><div class="lbl"><b>${label}</b><span>${sub}</span></div>${control}</div>`;
  const toggle = (key) => `<label class="toggle"><input type="checkbox" data-set="${key}" ${settings[key] ? 'checked' : ''}/><span></span></label>`;
  const sections = {
    appearance: () => `<h4>Appearance</h4><p class="sub">Pick a theme and make the accent yours.</p>
      <div class="set-label">Theme</div><div class="themes">${THEMES.map((t) => `
        <button class="theme-card ${settings.theme === t.id ? 'on' : ''}" data-theme-id="${t.id}">
          <div class="theme-prev" style="background:${t.prev[0]}"><i style="flex:1;background:${t.prev[1]}"></i><i style="width:14px;background:${t.prev[2]}"></i><i style="width:14px;background:${t.prev[3]}"></i></div>
          <div class="tname">${t.name}<span>${t.mode}</span></div></button>`).join('')}</div>
      <div class="set-label">Accent colour</div>
      <div class="swatches">
        <button class="swatch default ${!settings.accent ? 'on' : ''}" data-accent="" title="Theme default"></button>
        ${ACCENTS.map((c) => `<button class="swatch ${settings.accent === c ? 'on' : ''}" data-accent="${c}" style="background:${c}" title="${c}"></button>`).join('')}
        <label class="swatch custom ${settings.accent && !ACCENTS.includes(settings.accent) ? 'on' : ''}" title="Custom colour"><input type="color" data-accent-custom value="${settings.accent || '#9b8cff'}"/></label>
      </div>`,
    editor: () => `<h4>Editor</h4><p class="sub">How writing looks and feels.</p>
      ${row('Live preview', 'Show formatting as you type; markdown symbols appear only on the line you’re editing.', toggle('livePreview'))}
      ${row('Font', 'Typeface for notes.', `<select class="select" data-set="font"><option value="sans">Sans-serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select>`)}
      ${row('Font size', `<span data-size-label>${settings.fontSize}px</span>`, `<input type="range" min="13" max="22" step="1" value="${settings.fontSize}" data-set="fontSize"/>`)}
      ${row('Full-width notes', 'Let text span the whole pane instead of a comfortable reading width.', toggle('fullWidth'))}
      ${row('Typewriter scrolling', 'Keep the line you’re typing in the middle of the screen.', toggle('typewriter'))}
      ${row('New tabs open in', 'The view new tabs start in.', `<select class="select" data-set="defaultMode"><option value="edit">Editing</option><option value="read">Reading</option></select>`)}`,
    daily: () => `<h4>Daily notes</h4><p class="sub">One note per day, opened with Ctrl+Shift+D or from the calendar.</p>
      ${row('Folder', 'Where daily notes are stored (blank for the vault root).', `<input class="text-input" data-set="dailyFolder" value="${esc(settings.dailyFolder)}" spellcheck="false"/>`)}
      ${row('Format', 'File names use the date, e.g. ' + dayKey(new Date()) + '.', '<span class="muted">YYYY-MM-DD</span>')}`,
    vault: () => `<h4>Vault</h4><p class="sub">Your notes are plain Markdown files in a folder you own.</p>
      ${row('Current vault', esc(S.vault.path), '<button class="btn sm" data-act="reveal">Show folder</button>')}
      ${row('Switch vault', 'Open or create another folder of notes.', '<button class="btn sm" data-act="switch">Open vault…</button>')}`,
    keys: () => `<h4>Shortcuts</h4><p class="sub">Everything is also in the command palette (Ctrl+P).</p><div class="kbd-list">${[
      ['Command palette', 'Ctrl P'], ['Quick switcher', 'Ctrl O'], ['New note', 'Ctrl N'], ['Today’s daily note', 'Ctrl Shift D'],
      ['New tab / close tab', 'Ctrl T / Ctrl W'], ['Next / previous tab', 'Ctrl Tab / Ctrl Shift Tab'], ['Back / forward', 'Alt ← / Alt →'],
      ['Toggle reading view', 'Ctrl E'], ['Graph view', 'Ctrl G'], ['Search all notes', 'Ctrl Shift F'], ['Find in note', 'Ctrl F'],
      ['Focus mode', 'Ctrl Shift Enter'], ['Switch light / dark', 'Ctrl Shift L'], ['Toggle sidebar', 'Ctrl \\'], ['Settings', 'Ctrl ,'],
      ['Bold / italic', 'Ctrl B / Ctrl I'], ['Insert link', 'Ctrl K'], ['Toggle checkbox', 'Ctrl Enter'], ['Preview link', 'Ctrl + hover'], ['Open link in new tab', 'Ctrl + click'],
    ].map(([a, k]) => `<span>${a}</span><kbd>${k}</kbd>`).join('')}</div>`,
    about: () => `<h4>Weft</h4><p class="sub">Version ${esc(loom.version || '')} · a quiet place for connected thinking.</p>
      <p class="muted" style="font-size:13px;line-height:1.6">Weft keeps your notes as plain Markdown files on your computer. Nothing is uploaded anywhere.</p>`,
  };
  const show = (s) => {
    $$('.settings-nav button', back).forEach((b) => b.classList.toggle('on', b.dataset.s === s));
    body.innerHTML = sections[s]();
    $$('select[data-set]', body).forEach((x) => { x.value = settings[x.dataset.set]; });
  };
  $('.settings-nav', back).addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) show(b.dataset.s); });
  body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-theme-id]'); if (t) { setTheme(t.dataset.themeId); show('appearance'); return; }
    const a = e.target.closest('[data-accent]'); if (a) { settings.accent = a.dataset.accent || null; saveSettings(); applyAppearance(true); show('appearance'); return; }
    const act = e.target.closest('[data-act]');
    if (act) { back.remove(); if (act.dataset.act === 'reveal') loom.revealVault(); else switchVault(); }
  });
  body.addEventListener('input', (e) => {
    const x = e.target;
    if (x.dataset.accentCustom != null) { settings.accent = x.value; saveSettings(); applyAppearance(); return; }
    const key = x.dataset.set; if (!key) return;
    const val = x.type === 'checkbox' ? x.checked : x.type === 'range' ? Number(x.value) : x.value;
    if (key === 'fontSize') $('[data-size-label]', body).textContent = val + 'px';
    setSetting(key, val);
  });
  show(section);
}
$('#rb-settings').onclick = () => openSettings();
$('#rb-palette').onclick = openPalette;
$('#rb-daily').onclick = () => openDaily();

/* ================= Vault ================= */
async function switchVault() {
  const v = await loom.chooseVault();
  if (!v) return;
  await flushAll();
  S.vault = v;
  S.expanded = new Set(store.get('expanded:' + v.path, []));
  $('#vault-name').textContent = v.name;
  await loadNotes();
  while (S.panes.length > 1) removePane(S.panes[1]);
  const p = S.panes[0]; p.tabs = []; p.idx = -1;
  renderTree(); renderTags(); renderCalendar();
  if (!restoreWorkspace()) { const w = resolve('Welcome'); if (w) openNote(w); else p.show(); }
  if (S.view === 'graph') refreshGraph();
  toast(`Opened vault “${v.name}”`);
}
$('#vault-name').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, [
    { label: 'Open another vault…', icon: 'vault', run: switchVault },
    { label: 'Show vault folder', icon: 'external', run: () => loom.revealVault() },
    { label: 'Settings', icon: 'gear', run: () => openSettings('vault') },
  ]);
};

(() => {
  const rz = $('#sidebar-resizer'), sb = $('#sidebar');
  const setW = (w) => { sb.style.width = w + 'px'; document.body.style.setProperty('--sbw', w + 'px'); };
  setW(store.get('sbw', 264));
  rz.addEventListener('pointerdown', (e) => {
    rz.setPointerCapture(e.pointerId); rz.classList.add('drag'); sb.style.transition = 'none';
    const move = (ev) => setW(Math.max(200, Math.min(480, ev.clientX - sb.getBoundingClientRect().left)));
    const up = () => { rz.classList.remove('drag'); sb.style.transition = ''; store.set('sbw', parseInt(sb.style.width)); rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
  });
})();
$('#btn-new-note').onclick = () => newNote('');
$('#btn-new-folder').onclick = () => newFolder('');
$('#btn-collapse').onclick = () => { S.expanded.clear(); saveExpanded(); renderTree(); };
$('#tb-search').onclick = openSwitcher;

/* ================= Keyboard ================= */
// App shortcuts run in the capture phase so they win over the editor's own keymap.
window.addEventListener('keydown', (e) => {
  if (el.modal.childElementCount) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  let handled = true;
  if (mod && !e.shiftKey && !e.altKey) {
    switch (k) {
      case 'o': openSwitcher(); break;
      case 'p': openPalette(); break;
      case 'n': newNote(); break;
      case 't': S.active.newTab(); break;
      case 'w': S.active.closeTab(S.active.idx); break;
      case 'g': showGraph(); break;
      case 'e': toggleMode(); break;
      case ',': openSettings(); break;
      case '\\': toggleSidebar(); break;
      case 's': flushAll(); break;
      case 'tab': cycleTab(1); break;
      default: handled = false;
    }
  } else if (mod && e.shiftKey && !e.altKey) {
    switch (k) {
      case 'f': showPanel('search'); break;
      case 'l': toggleTheme(); break;
      case 'd': openDaily(); break;
      case 'enter': toggleFocus(); break;
      case 'tab': cycleTab(-1); break;
      default: handled = false;
    }
  } else if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.key === 'ArrowLeft' ? S.active.back() : S.active.fwd();
  } else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, true);
// Escape and Space fall through to here only if nothing else (editor popups, modals) used them.
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || el.modal.childElementCount) return;
  const typing = e.target.closest && e.target.closest('input, textarea, .cm-editor');
  if (e.key === ' ' && TL && !typing) { e.preventDefault(); setTlPlaying(!TL.playing); return; }
  if (e.key !== 'Escape') return;
  if (!el.ctx.classList.contains('hidden')) { el.ctx.classList.add('hidden'); return; }
  if (!el.hover.classList.contains('hidden')) { el.hover.classList.add('hidden'); return; }
  if (TL) { stopTimelapse(); return; }
  if (S.view === 'graph') { showGraph(false); return; }
  if (document.body.classList.contains('focus')) toggleFocus(false);
});
// Synchronous write so a keystroke made right before closing the window is never lost.
window.addEventListener('beforeunload', () => {
  for (const p of S.dirty) { const n = S.notes.get(p); if (n) loom.writeNoteSync(p, n.content); }
  S.dirty.clear();
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { if (!el.tree.contains(e.target)) e.preventDefault(); });

/* ================= Boot ================= */
(async function init() {
  hydrateIcons();
  document.body.classList.add('platform-' + loom.platform);
  S.vault = await loom.getVault();
  applyAppearance();
  $('#vault-name').textContent = S.vault.name;
  S.expanded = new Set(store.get('expanded:' + S.vault.path, []));
  if (store.get('noRight', false)) document.body.classList.add('no-right');
  if (store.get('gpCollapsed', false)) $('#graph-panel').classList.add('collapsed');
  $$('#lg-depth button').forEach((b) => b.classList.toggle('on', Number(b.dataset.d) === S.lgDepth));
  toggleSidebar(store.get('noSidebar', false));
  await loadNotes();
  setActivePane(addPane());
  renderTree(); renderTags(); runSearch();
  if (!restoreWorkspace()) {
    const last = store.get('last:' + S.vault.path, null);
    const start = (last && S.notes.has(last) && last) || resolve('Welcome');
    if (start) openNote(start); else S.active.show();
  }
  loom.onVaultChanged(debounce(reloadFromDisk, 150));
})();
