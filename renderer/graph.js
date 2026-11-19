// Weft graph: force-directed layout on <canvas>, no dependencies.
// Used for the full graph, the local graph and the exported web page.
class Graph {
  constructor(canvas, { onOpen, onHover, mini = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onOpen = onOpen || (() => {});
    this.onHover = onHover || (() => {});
    this.mini = mini;
    this.nodes = [];
    this.links = [];
    this.byId = new Map();
    this.adj = new Map();
    this.view = { k: 1, x: 0, y: 0 };
    this.target = null;
    this.alpha = 1;
    this.hover = null;
    this.drag = null;
    this.current = null;
    this.running = false;
    this.frozen = false; // time-lapse: positions fixed, nodes revealed over time
    this.dirty = true;
    this.settings = mini
      ? { size: 0.8, dist: 55, repel: 160, label: 0, arrows: false, folders: true }
      : { size: 1, dist: 80, repel: 300, label: 0.45, arrows: false, folders: true };
    this.colors = {};
    this.dpr = window.devicePixelRatio || 1;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // ---------- data ----------
  setData(nodes, links, { animate = true } = {}) {
    // Same nodes and links as last time: just refresh labels, don't disturb the layout.
    const sig = nodes.map((n) => n.id).join('|') + '#' + links.map((l) => l.source + '>' + l.target).join('|');
    if (sig === this.sig) {
      for (const n of nodes) { const m = this.byId.get(n.id); if (m) Object.assign(m, n, { x: m.x, y: m.y }); }
      this.dirty = true;
      return;
    }
    this.sig = sig;
    const old = this.byId;
    const now = performance.now();
    this.byId = new Map();
    this.nodes = nodes.map((n, i) => {
      const prev = old.get(n.id);
      const node = prev ? Object.assign(prev, n) : {
        ...n,
        x: n.x ?? Math.cos(i * 2.4) * Math.sqrt(i + 1) * 18,
        y: n.y ?? Math.sin(i * 2.4) * Math.sqrt(i + 1) * 18,
        vx: 0, vy: 0, h: 1, born: animate ? now + Math.min(i, 60) * 12 : 0,
      };
      node.deg = 0;
      this.byId.set(n.id, node);
      return node;
    });
    this.links = [];
    this.adj = new Map(this.nodes.map((n) => [n.id, new Set()]));
    for (const l of links) {
      const s = this.byId.get(l.source), t = this.byId.get(l.target);
      if (!s || !t || s === t) continue;
      this.links.push({ s, t, kind: l.kind || 'link' });
      s.deg++; t.deg++;
      this.adj.get(s.id).add(t.id); this.adj.get(t.id).add(s.id);
    }
    for (const n of this.nodes) {
      if (old.has(n.id)) continue;
      const nb = [...this.adj.get(n.id)].map((id) => this.byId.get(id)).find((m) => old.has(m.id));
      if (nb) { n.x = nb.x + (Math.random() - .5) * 30; n.y = nb.y + (Math.random() - .5) * 30; }
    }
    for (const n of this.nodes) n.r = this.radius(n);
    if (this.hover && !this.byId.has(this.hover.id)) this.hover = null;
    const first = !old.size;
    if (first && this.w) this.view = { k: 1, x: this.w / 2, y: this.h / 2 };
    this.reheat(first ? 1 : 0.5);
    if (first) {
      // Run part of the layout up front so the graph opens already mostly untangled.
      for (let i = 0; i < 70; i++) this.step();
      this.fit(false, this.fitInset);
      this.requestFit();
    }
    this.dirty = true;
  }

  radius(n) {
    const base = n.type === 'tag' ? 3.2 : n.type === 'ghost' ? 2.8 : 4;
    return (base + Math.sqrt(n.deg) * 2.1) * this.settings.size;
  }

  set(key, val) {
    this.settings[key] = val;
    if (key === 'size') for (const n of this.nodes) n.r = this.radius(n);
    if (key === 'dist' || key === 'repel') this.reheat(0.6);
    this.dirty = true;
  }

  setCurrent(id) { this.current = id; this.dirty = true; }
  // Fit the view once the layout has settled (unless the user starts panning first).
  requestFit() { this.pendingFit = true; }
  reheat(a = 0.7) { if (!this.frozen) this.alpha = Math.max(this.alpha, a); this.dirty = true; }

  refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.colors = {
      edge: v('--g-edge'), node: v('--g-node'), ghost: v('--g-ghost'), label: v('--g-label'),
      accent: v('--accent'), tag: v('--tag'), glow: v('--accent-glow'), bg: v('--bg'),
      palette: ['--g1', '--g2', '--g3', '--g4', '--g5', '--g6'].map(v),
    };
    this.dirty = true;
  }

  // ---------- time-lapse ----------
  // order: Map id -> reveal index. Nodes whose index is above `step` stay hidden.
  freeze(on) {
    this.frozen = on;
    if (on) { this.alpha = 0; for (const n of this.nodes) { n.vx = n.vy = 0; } }
    else { for (const n of this.nodes) n.hidden = false; }
    this.dirty = true;
  }
  revealUpTo(order, step) {
    const now = performance.now();
    for (const n of this.nodes) {
      const hide = (order.get(n.id) ?? 0) > step;
      if (n.hidden && !hide) n.born = now;
      n.hidden = hide;
    }
    this.dirty = true;
  }

  // ---------- loop ----------
  start() {
    if (this.running) return;
    this.running = true;
    this.refreshColors();
    this.resize();
    const loop = () => {
      if (!this.running) return;
      if (this.alpha > 0.004 && !this.frozen) { this.step(); this.dirty = true; }
      if (this.pendingFit && (this.alpha < 0.06 || this.frozen) && !this.drag) { this.pendingFit = false; this.fit(true, this.fitInset); }
      if (this.target) { this.animateView(); this.dirty = true; }
      if (this.dirty || this.drag) { this.dirty = false; this.draw(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const first = !this.w;
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = r.width * this.dpr;
    this.canvas.height = r.height * this.dpr;
    if (first) this.view = { k: 1, x: r.width / 2, y: r.height / 2 };
    this.dirty = true;
  }

  step() {
    const N = this.nodes, a = this.alpha, S = this.settings;
    for (let i = 0; i < N.length; i++) {
      const p = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const q = N[j];
        let dx = q.x - p.x, dy = q.y - p.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 360000) continue;
        if (d2 < 1) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 1; }
        const f = (S.repel * a) / Math.max(d2, 64);
        const fx = dx * f, fy = dy * f;
        p.vx -= fx; p.vy -= fy; q.vx += fx; q.vy += fy;
      }
    }
    for (const { s, t } of this.links) {
      const dx = t.x - s.x, dy = t.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const k = ((d - S.dist) / d) * 0.1 * a;
      const bias = s.deg / (s.deg + t.deg);
      t.vx -= dx * k * bias; t.vy -= dy * k * bias;
      s.vx += dx * k * (1 - bias); s.vy += dy * k * (1 - bias);
    }
    for (const n of N) {
      n.vx -= n.x * 0.02 * a; n.vy -= n.y * 0.02 * a;
      if (n === this.drag?.node) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.58; n.vy *= 0.58;
      const sp = Math.hypot(n.vx, n.vy);
      if (sp > 40) { n.vx *= 40 / sp; n.vy *= 40 / sp; }
      n.x += n.vx; n.y += n.vy;
    }
    this.alpha *= this.drag ? 1 : 0.982;
  }

  animateView() {
    const v = this.view, t = this.target, e = 0.14;
    v.k += (t.k - v.k) * e; v.x += (t.x - v.x) * e; v.y += (t.y - v.y) * e;
    if (Math.abs(t.k - v.k) < 0.001 && Math.abs(t.x - v.x) < 0.3 && Math.abs(t.y - v.y) < 0.3) this.target = null;
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r + 16); }
    return { x0, y0, x1, y1 };
  }

  fit(animate = true, rightInset = 0) {
    if (!this.nodes.length || !this.w) return;
    const { x0, y0, x1, y1 } = this.bounds();
    const pad = this.mini ? 24 : 70;
    const w = this.w - rightInset;
    const k = Math.min(this.mini ? 1.6 : 2.2, Math.min((w - pad * 2) / Math.max(1, x1 - x0), (this.h - pad * 2) / Math.max(1, y1 - y0)));
    const t = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: this.h / 2 - ((y0 + y1) / 2) * k };
    if (animate) this.target = t; else { this.view = t; this.dirty = true; }
  }

  focus(id) {
    const n = this.byId.get(id);
    if (!n) return;
    const k = Math.max(this.view.k, 1.4);
    this.target = { k, x: this.w / 2 - n.x * k, y: this.h / 2 - n.y * k };
  }

  // ---------- drawing ----------
  nodeColor(n) {
    const c = this.colors;
    if (n.type === 'tag') return c.tag;
    if (n.type === 'ghost') return c.ghost;
    if (!this.settings.folders || !n.group) return c.node;
    return c.palette[n.groupIndex % c.palette.length];
  }

  appear(n, now) {
    if (!n.born) return 1;
    const t = Math.min(1, Math.max(0, (now - n.born) / 420));
    if (t < 1) this.dirty = true;
    const c = 1.7; // ease-out-back: a soft "pop"
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  }

  draw(target) {
    const exporting = !!target;
    const ctx = exporting ? target.ctx : this.ctx;
    const v = exporting ? target.view : this.view;
    const W = exporting ? target.w : this.w, H = exporting ? target.h : this.h;
    const dpr = exporting ? target.scale : this.dpr;
    const c = this.colors;
    const k = v.k;
    const now = performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (exporting && target.bg) { ctx.fillStyle = target.bg; ctx.fillRect(0, 0, W, H); }
    ctx.translate(v.x, v.y);
    ctx.scale(k, k);

    const focus = exporting ? null : this.hover || (this.drag && this.drag.node);
    const nb = focus ? this.adj.get(focus.id) : null;
    for (const n of this.nodes) {
      const tgt = !focus || n === focus || nb.has(n.id) ? 1 : 0.12;
      if (exporting) { n._h = n.h; n.h = 1; continue; }
      const d = tgt - n.h;
      if (Math.abs(d) > 0.004) { n.h += d * 0.18; this.dirty = true; } else n.h = tgt;
    }
    const vis = (n) => !n.hidden;
    const ap = new Map();
    for (const n of this.nodes) ap.set(n, exporting ? 1 : this.appear(n, now));

    ctx.lineCap = 'round';
    for (const l of this.links) {
      if (!vis(l.s) || !vis(l.t)) continue;
      const lit = focus && (l.s === focus || l.t === focus);
      const grow = Math.min(ap.get(l.s), ap.get(l.t));
      const al = Math.min(l.s.h, l.t.h) * Math.min(1, grow);
      ctx.globalAlpha = lit ? 0.95 : al * (l.kind === 'tag' ? 0.6 : 1);
      ctx.strokeStyle = lit ? c.accent : c.edge;
      ctx.lineWidth = (lit ? 1.6 : 1) / Math.sqrt(k);
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
      if (this.settings.arrows && l.kind === 'link') this.arrow(ctx, l, lit ? c.accent : c.edge, k);
    }

    for (const n of this.nodes) {
      if (!vis(n)) continue;
      const isFocus = n === focus, isCur = n.id === this.current;
      const col = isFocus ? c.accent : this.nodeColor(n);
      const a = ap.get(n);
      ctx.globalAlpha = Math.max(n.h, 0.08) * Math.min(1, a * 1.5);
      if (isFocus || isCur || a < 1) { ctx.shadowColor = c.glow; ctx.shadowBlur = a < 1 ? 24 : 18; }
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(0.1, n.r * (isFocus ? 1.25 : 1) * a), 0, Math.PI * 2);
      if (n.type === 'ghost') { ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.stroke(); }
      else ctx.fill();
      ctx.shadowBlur = 0;
      if (isCur) {
        ctx.strokeStyle = c.accent; ctx.lineWidth = 1.6 / k;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4 / k + 2, 0, Math.PI * 2); ctx.stroke();
      }
    }

    const fade = exporting || this.mini ? 1 : Math.min(1, Math.max(0, (k - this.settings.label) / 0.45));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const fs = (this.mini ? 10.5 : 12) / Math.pow(k, 0.55);
    ctx.font = `500 ${fs}px "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif`;
    for (const n of this.nodes) {
      if (!vis(n)) continue;
      const near = focus && (n === focus || nb.has(n.id));
      let a = near ? 1 : focus ? fade * n.h : fade;
      if (n.id === this.current) a = Math.max(a, 0.9);
      a *= Math.min(1, ap.get(n));
      if (a < 0.03) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = n === focus ? c.accent : n.type === 'tag' ? c.tag : c.label;
      ctx.fillText(n.label, n.x, n.y + n.r + 4 / Math.sqrt(k));
    }
    ctx.globalAlpha = 1;
    if (exporting) for (const n of this.nodes) n.h = n._h;
  }

  arrow(ctx, l, color, k) {
    const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d, sz = 5 / Math.sqrt(k);
    const ex = l.t.x - ux * (l.t.r + 2), ey = l.t.y - uy * (l.t.r + 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - ux * sz * 1.8 - uy * sz, ey - uy * sz * 1.8 + ux * sz);
    ctx.lineTo(ex - ux * sz * 1.8 + uy * sz, ey - uy * sz * 1.8 - ux * sz);
    ctx.fill();
  }

  // Render the whole graph into a new high-resolution canvas (PNG export).
  renderImage({ width = 2400, height = 1600, bg } = {}) {
    const cv = document.createElement('canvas');
    cv.width = width; cv.height = height;
    const { x0, y0, x1, y1 } = this.bounds();
    const pad = Math.min(width, height) * 0.06;
    const k = Math.min((width - pad * 2) / Math.max(1, x1 - x0), (height - pad * 2) / Math.max(1, y1 - y0));
    const view = { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
    this.draw({ ctx: cv.getContext('2d'), view, w: width, h: height, scale: 1, bg });
    this.dirty = true;
    return cv;
  }

  // ---------- interaction ----------
  toWorld(px, py) { return { x: (px - this.view.x) / this.view.k, y: (py - this.view.y) / this.view.k }; }
  hit(px, py) {
    const p = this.toWorld(px, py);
    let best = null, bd = Infinity;
    for (const n of this.nodes) {
      if (n.hidden) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      const lim = n.r + 6 / this.view.k;
      if (d < lim && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  _bind() {
    const cv = this.canvas;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cv.setPointerCapture(e.pointerId);
      this.pendingFit = false;
      const p = pos(e);
      const node = this.hit(p.x, p.y);
      this.target = null;
      this.drag = node
        ? { node, sx: p.x, sy: p.y, moved: false }
        : { pan: true, sx: p.x, sy: p.y, vx: this.view.x, vy: this.view.y, moved: false };
      cv.classList.add('grabbing');
    });

    cv.addEventListener('pointermove', (e) => {
      const p = pos(e);
      const d = this.drag;
      if (d) {
        if (Math.hypot(p.x - d.sx, p.y - d.sy) > 3) d.moved = true;
        if (d.pan) { this.view.x = d.vx + p.x - d.sx; this.view.y = d.vy + p.y - d.sy; }
        else if (d.moved && !this.frozen) { const w = this.toWorld(p.x, p.y); d.node.x = w.x; d.node.y = w.y; this.reheat(0.3); }
        this.dirty = true;
        return;
      }
      const n = this.hit(p.x, p.y);
      if (n !== this.hover) {
        this.hover = n;
        cv.classList.toggle('pointer', !!n);
        this.dirty = true;
      }
      this.onHover(n, e.clientX, e.clientY);
    });

    const end = (e) => {
      const d = this.drag;
      this.drag = null;
      cv.classList.remove('grabbing');
      if (d && d.node && !d.moved) this.onOpen(d.node, e);
      this.dirty = true;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.onHover(null); this.dirty = true; } });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.target = null;
      this.pendingFit = false;
      const p = pos(e);
      const f =Math.exp(-e.deltaY * 0.0015);
      const k = Math.min(8, Math.max(0.08, this.view.k * f));
      const w = this.toWorld(p.x, p.y);
      this.view.k = k;
      this.view.x = p.x - w.x * k;
      this.view.y = p.y - w.y * k;
      this.dirty = true;
    }, { passive: false });

    cv.addEventListener('dblclick', (e) => { if (!this.hit(pos(e).x, pos(e).y)) this.fit(true); });
  }
}
window.Graph = Graph;
