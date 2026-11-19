// Weft editor: CodeMirror 6 with an Obsidian-style live preview.
// Bundled by esbuild into renderer/editor.bundle.js (exposes window.WeftEditor).
import { EditorState, Compartment, StateEffect, EditorSelection } from '@codemirror/state';
import {
  EditorView, keymap, Decoration, ViewPlugin, WidgetType, drawSelection, placeholder, dropCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { syntaxTree, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

const refreshEffect = StateEffect.define();

const highlight = HighlightStyle.define([
  { tag: t.heading1, class: 'tok-h tok-h1' },
  { tag: t.heading2, class: 'tok-h tok-h2' },
  { tag: t.heading3, class: 'tok-h tok-h3' },
  { tag: [t.heading4, t.heading5, t.heading6], class: 'tok-h tok-h4' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.emphasis, class: 'tok-em' },
  { tag: t.strikethrough, class: 'tok-strike' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.url, class: 'tok-url' },
  { tag: t.monospace, class: 'tok-code' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: [t.processingInstruction, t.meta], class: 'tok-mark' },
  { tag: t.contentSeparator, class: 'tok-hr' },
  { tag: t.list, class: 'tok-list' },
]);

// ---------- widgets ----------
class CheckboxWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-lp-check';
    box.checked = this.checked;
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent() { return true; }
}
class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-lp-bullet'; s.textContent = '•'; return s; }
}
class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-lp-hr'; return s; }
}
class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(o) { return o.src === this.src; }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'cm-lp-img'; img.src = this.src; img.alt = this.alt; img.draggable = false;
    return img;
  }
}

const hide = Decoration.replace({});
const WIKI = /\[\[([^[\]\n]+?)\]\]/g;
const TAG = /(^|[\s(])#([A-Za-z][\w\-/]*)/g;

// Raw markdown is shown only where the cursor is — and only while the editor has focus.
let focusedView = null;
function selTouches(state, from, to) {
  if (!focusedView || focusedView.state !== state) return false;
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function buildDecorations(view, opts) {
  const { state } = view;
  focusedView = view.hasFocus ? view : null;
  const decos = [];
  const atomic = [];
  const push = (d) => { decos.push(d); if (d.value.point || d.value.spec.widget || d.value === hide) atomic.push(d); };
  const activeLines = new Set();
  if (focusedView) for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number, b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) activeLines.add(i);
  }
  const lineActive = (pos) => activeLines.has(state.doc.lineAt(pos).number);
  const tree = syntaxTree(state);
  const codeRanges = [];

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        const name = node.name;
        const m = /^ATXHeading(\d)$/.exec(name);
        if (m) {
          const line = state.doc.lineAt(node.from);
          push(Decoration.line({ class: `cm-lp-h cm-lp-h${m[1]}` }).range(line.from));
          return;
        }
        if (name === 'HeaderMark' && /^ATX/.test(node.node.parent?.name || '')) {
          if (!lineActive(node.from)) {
            const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            push(hide.range(node.from, end));
          }
          return;
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          codeRanges.push([node.from, node.to]);
          const first = state.doc.lineAt(node.from).number, last = state.doc.lineAt(node.to).number;
          for (let i = first; i <= last; i++) {
            const cls = 'cm-lp-codeblock' + (i === first ? ' cm-lp-cb-first' : '') + (i === last ? ' cm-lp-cb-last' : '');
            push(Decoration.line({ class: cls }).range(state.doc.line(i).from));
          }
          return false;
        }
        if (name === 'InlineCode') {
          codeRanges.push([node.from, node.to]);
          push(Decoration.mark({ class: 'cm-lp-code' }).range(node.from, node.to));
          if (!selTouches(state, node.from, node.to)) {
            const c = node.node.getChildren('CodeMark');
            for (const mk of c) push(hide.range(mk.from, mk.to));
          }
          return false;
        }
        if (name === 'Emphasis' || name === 'StrongEmphasis' || name === 'Strikethrough') {
          if (!selTouches(state, node.from, node.to)) {
            const markName = name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark';
            for (const mk of node.node.getChildren(markName)) push(hide.range(mk.from, mk.to));
          }
          return;
        }
        if (name === 'Link') {
          const url = node.node.getChild('URL');
          const href = url ? state.sliceDoc(url.from, url.to) : '';
          if (!selTouches(state, node.from, node.to) && href) {
            const marks = node.node.getChildren('LinkMark');
            if (marks.length >= 2) {
              push(hide.range(marks[0].from, marks[0].to));
              push(Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': href } }).range(marks[0].to, marks[1].from));
              push(hide.range(marks[1].from, node.to));
            }
          }
          return false;
        }
        if (name === 'Image') {
          const url = node.node.getChild('URL');
          if (url && !selTouches(state, node.from, node.to)) {
            const href = state.sliceDoc(url.from, url.to);
            const alt = state.sliceDoc(node.from + 2, Math.max(node.from + 2, (node.node.getChildren('LinkMark')[1] || url).from));
            const src = opts.resolveImage ? opts.resolveImage(href) : href;
            push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to));
          }
          return false;
        }
        if (name === 'Blockquote') {
          const first = state.doc.lineAt(node.from).number, last = state.doc.lineAt(node.to).number;
          for (let i = first; i <= last; i++) push(Decoration.line({ class: 'cm-lp-quote' }).range(state.doc.line(i).from));
          return;
        }
        if (name === 'QuoteMark') {
          if (!lineActive(node.from)) {
            const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            push(hide.range(node.from, end));
          }
          return;
        }
        if (name === 'ListMark') {
          const sib = node.node.nextSibling;
          const isTask = sib && sib.name === 'Task';
          const mark = state.sliceDoc(node.from, node.to);
          if (lineActive(node.from)) return;
          if (isTask) {
            const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            push(hide.range(node.from, end));
          } else if (/^[-*+]$/.test(mark)) {
            push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
          }
          return;
        }
        if (name === 'TaskMarker') {
          const text = state.sliceDoc(node.from, node.to);
          const checked = /x/i.test(text);
          if (checked) push(Decoration.line({ class: 'cm-lp-done' }).range(state.doc.lineAt(node.from).from));
          if (!selTouches(state, node.from, node.to)) {
            push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to));
          }
          return;
        }
        if (name === 'HorizontalRule') {
          if (!lineActive(node.from)) push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
          return;
        }
      },
    });

    // Wiki links and tags (regex, skipping code)
    const inCode = (p) => codeRanges.some(([a, b]) => p >= a && p < b);
    const text = state.sliceDoc(from, to);
    let mm;
    WIKI.lastIndex = 0;
    while ((mm = WIKI.exec(text))) {
      const s = from + mm.index, e = s + mm[0].length;
      if (inCode(s)) continue;
      const [tp, alias] = mm[1].split('|');
      const target = tp.split('#')[0].trim();
      const exists = opts.resolveLink ? opts.resolveLink(target) : true;
      const cls = 'cm-wikilink' + (exists ? '' : ' cm-wl-missing');
      if (selTouches(state, s, e)) {
        push(Decoration.mark({ class: cls, attributes: { 'data-target': target } }).range(s, e));
      } else {
        const shownFrom = alias != null ? s + 2 + tp.length + 1 : s + 2;
        push(hide.range(s, shownFrom));
        push(Decoration.mark({ class: cls + ' cm-wl-rendered', attributes: { 'data-target': target } }).range(shownFrom, e - 2));
        push(hide.range(e - 2, e));
      }
    }
    TAG.lastIndex = 0;
    while ((mm = TAG.exec(text))) {
      const s = from + mm.index + mm[1].length, e = s + mm[2].length + 1;
      if (inCode(s)) continue;
      push(Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': mm[2].toLowerCase() } }).range(s, e));
    }
  }
  return { all: Decoration.set(decos, true), atomic: Decoration.set(atomic, true) };
}

function livePreview(opts) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.set(buildDecorations(view, opts)); }
    set(r) { this.decorations = r.all; this.atomic = r.atomic; }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged ||
          u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect)))) {
        this.set(buildDecorations(u.view, opts));
      }
    }
  }, {
    decorations: (v) => v.decorations,
    // Hidden markup should be skipped by the cursor as a single unit.
    provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic || Decoration.none),
  });
}

// Source mode still gets clickable wiki links and tags, just without hiding syntax.
function sourceLinks(opts) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) { if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect)))) this.decorations = this.build(u.view); }
    build(view) {
      const decos = [];
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to);
        let m; WIKI.lastIndex = 0;
        while ((m = WIKI.exec(text))) {
          const target = m[1].split('|')[0].split('#')[0].trim();
          const exists = opts.resolveLink ? opts.resolveLink(target) : true;
          decos.push(Decoration.mark({ class: 'cm-wikilink' + (exists ? '' : ' cm-wl-missing'), attributes: { 'data-target': target } }).range(from + m.index, from + m.index + m[0].length));
        }
        TAG.lastIndex = 0;
        while ((m = TAG.exec(text))) {
          const s = from + m.index + m[1].length;
          decos.push(Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': m[2].toLowerCase() } }).range(s, s + m[2].length + 1));
        }
      }
      return Decoration.set(decos, true);
    }
  }, { decorations: (v) => v.decorations });
}

// ---------- completions ----------
function completions(opts) {
  return (ctx) => {
    const w = ctx.matchBefore(/\[\[[^[\]\n|#]*$/);
    if (w) {
      const q = w.text.slice(2);
      const items = opts.getLinkOptions ? opts.getLinkOptions(q) : [];
      return {
        from: w.from + 2,
        filter: false,
        options: items.map((it) => ({
          label: it.label,
          detail: it.detail || '',
          type: it.create ? 'create' : 'note',
          apply: (view, _c, from, to) => {
            // Swallow any closing brackets already after the cursor (one or two), then write a clean ]].
            let end = to;
            while (end < to + 2 && view.state.sliceDoc(end, end + 1) === ']') end++;
            const insert = it.text + ']]';
            view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length } });
          },
        })),
      };
    }
    const tg = ctx.matchBefore(/(?:^|\s)#[\w\-/]*$/);
    if (tg && (tg.text.trim().length > 1 || ctx.explicit)) {
      const start = tg.from + tg.text.indexOf('#') + 1;
      const tags = opts.getTags ? opts.getTags() : [];
      return { from: start, validFor: /^[\w\-/]*$/, options: tags.map((x) => ({ label: x, type: 'tag' })) };
    }
    return null;
  };
}

// ---------- commands ----------
function wrap(before, after = before) {
  return (view) => {
    view.dispatch(view.state.changeByRange((r) => {
      const text = view.state.sliceDoc(r.from, r.to);
      return {
        changes: { from: r.from, to: r.to, insert: before + text + after },
        range: EditorSelection.range(r.from + before.length, r.to + before.length),
      };
    }));
    return true;
  };
}
function toggleTaskAtCursor(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^(\s*[-*+] )\[([ xX])\]/.exec(line.text);
  if (m) {
    const pos = line.from + m[1].length + 1;
    view.dispatch({ changes: { from: pos, to: pos + 1, insert: m[2] === ' ' ? 'x' : ' ' } });
  } else {
    const lm = /^(\s*)([-*+] )?/.exec(line.text);
    const insertAt = line.from + lm[0].length;
    view.dispatch({ changes: { from: line.from + lm[1].length, to: insertAt, insert: '- [ ] ' } });
  }
  return true;
}

// ---------- factory ----------
function create(opts) {
  const lp = new Compartment();
  let typewriter = !!opts.typewriter;
  let lpOn = opts.livePreview !== false;

  const extensions = () => [
    history(),
    drawSelection(),
    dropCursor(),
    closeBrackets(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(highlight),
    placeholder(opts.placeholder || ''),
    autocompletion({ override: [completions(opts)], icons: false, closeOnBlur: true }),
    lp.of(lpOn ? livePreview(opts) : sourceLinks(opts)),
    keymap.of([
      { key: 'Mod-b', run: wrap('**') },
      { key: 'Mod-i', run: wrap('*') },
      { key: 'Mod-k', run: (v) => { wrap('[[', ']]')(v); startCompletion(v); return true; } },
      { key: 'Mod-Enter', run: toggleTaskAtCursor },
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...markdownKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && opts.onChange) opts.onChange(u.state.doc.toString());
      if (typewriter && (u.selectionSet || u.docChanged) && u.view.hasFocus) {
        const head = u.state.selection.main.head;
        requestAnimationFrame(() => u.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) }));
      }
      if (u.selectionSet && opts.onSelection) opts.onSelection(u.state.selection.main.head);
    }),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        const wl = e.target.closest('.cm-wikilink');
        if (wl && (wl.classList.contains('cm-wl-rendered') || e.ctrlKey || e.metaKey) && e.button === 0) {
          e.preventDefault();
          opts.onOpenLink && opts.onOpenLink(wl.dataset.target, e.ctrlKey || e.metaKey);
          return true;
        }
        const ln = e.target.closest('.cm-lp-link');
        if (ln && e.button === 0) { e.preventDefault(); opts.onOpenUrl && opts.onOpenUrl(ln.dataset.href); return true; }
        const tg = e.target.closest('.cm-tag');
        if (tg && (e.ctrlKey || e.metaKey)) { e.preventDefault(); opts.onTag && opts.onTag(tg.dataset.tag); return true; }
        return false;
      },
      auxclick(e) {
        const wl = e.target.closest('.cm-wikilink');
        if (wl && e.button === 1) { e.preventDefault(); opts.onOpenLink && opts.onOpenLink(wl.dataset.target, true); return true; }
        return false;
      },
      mouseover(e) {
        const wl = e.target.closest('.cm-wikilink');
        if (wl && opts.onHoverLink) opts.onHoverLink(wl.dataset.target, wl, e);
        return false;
      },
      mouseout(e) {
        const wl = e.target.closest('.cm-wikilink');
        if (wl && opts.onHoverEnd) opts.onHoverEnd(e);
        return false;
      },
    }),
  ];

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({ doc: opts.doc || '', extensions: extensions() }),
  });

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(text, { keepSelection = true } = {}) {
      if (text === view.state.doc.toString()) return;
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: keepSelection ? { anchor: head } : { anchor: 0 },
      });
    },
    // Replace the whole state (used when switching notes so undo history doesn't leak between notes).
    load(text, sel = 0) {
      view.setState(EditorState.create({ doc: text, extensions: extensions(), selection: { anchor: Math.min(sel, text.length) } }));
    },
    getSelection: () => view.state.selection.main.head,
    focus: () => view.focus(),
    refresh: () => view.dispatch({ effects: refreshEffect.of(null) }),
    setLivePreview(on) { lpOn = on; view.dispatch({ effects: lp.reconfigure(on ? livePreview(opts) : sourceLinks(opts)) }); },
    setTypewriter(on) { typewriter = on; },
    toggleTask: () => toggleTaskAtCursor(view),
    scrollToLine(n) {
      const line = view.state.doc.line(Math.min(Math.max(1, n), view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 80 }) });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}

window.WeftEditor = { create };
