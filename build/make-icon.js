// Renders build/icon.png (512x512) with no dependencies: run `node build/make-icon.js`.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const W = 512, SS = 3;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const C = { a: hex('#9b8cff'), t: hex('#7dd3c0'), p: hex('#f472b6'), o: hex('#f4a261'), l: hex('#c4bbff') };
const nodes = [
  { x: 236, y: 268, r: 66, c: C.a },
  { x: 372, y: 150, r: 40, c: C.t },
  { x: 388, y: 352, r: 33, c: C.p },
  { x: 128, y: 136, r: 30, c: C.o },
  { x: 150, y: 398, r: 24, c: C.t },
];
const edges = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2]];
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};
const rrect = (x, y, m, r) => { // signed distance to rounded square with margin m
  const hx = W / 2 - m, cx = Math.abs(x - W / 2) - hx + r, cy = Math.abs(y - W / 2) - hx + r;
  return Math.min(Math.max(cx, cy), 0) + Math.hypot(Math.max(cx, 0), Math.max(cy, 0)) - r;
};
function sample(x, y) {
  if (rrect(x, y, 16, 112) > 0) return [0, 0, 0, 0];
  const g = (x + y) / (2 * W);
  let col = [0.12 - g * 0.06, 0.10 - g * 0.05, 0.19 - g * 0.09];
  const over = (c, a) => { col = col.map((v, i) => v * (1 - a) + c[i] * a); };
  // soft glow behind centre node
  const dg = Math.hypot(x - nodes[0].x, y - nodes[0].y);
  over(C.a, 0.35 * Math.exp(-((dg / 150) ** 2)));
  for (const [i, j] of edges) {
    const a = nodes[i], b = nodes[j];
    if (segDist(x, y, a.x, a.y, b.x, b.y) < 7) over(C.l, 0.55);
  }
  for (const n of nodes) {
    const d = Math.hypot(x - n.x, y - n.y);
    if (d < n.r + 10) over(n.c, 0.18 * (1 - Math.max(0, d - n.r) / 10));
    if (d < n.r) { const hl = Math.max(0, 1 - Math.hypot(x - n.x + n.r * .35, y - n.y + n.r * .35) / n.r); over(n.c.map((v) => Math.min(1, v + hl * 0.25)), 1); }
  }
  return [...col, 1];
}
const raw = Buffer.alloc((W * 4 + 1) * W);
for (let y = 0; y < W; y++) {
  raw[y * (W * 4 + 1)] = 0;
  for (let x = 0; x < W; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const s = sample(x + (sx + .5) / SS, y + (sy + .5) / SS);
      acc = acc.map((v, i) => v + (i < 3 ? s[i] * s[3] : s[3]));
    }
    const a = acc[3] / (SS * SS), o = y * (W * 4 + 1) + 1 + x * 4;
    for (let i = 0; i < 3; i++) raw[o + i] = a ? Math.round(255 * acc[i] / acc[3]) : 0;
    raw[o + 3] = Math.round(255 * a);
  }
}
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(path.join(__dirname, 'icon.png'), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
console.log('wrote build/icon.png');
