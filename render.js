// Pure-JS icon renderer. Shapes are drawn with anti-aliased signed-distance
// math straight into an RGBA buffer; text uses `pureimage` + a bundled TTF.
// No native modules -> works the same on Windows and macOS.

import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as PImage from 'pureimage';

export const SIZE = 144;

// ---------- font ----------
const FONT_FAMILY = 'SMFont';
let fontReady = false;
try {
  const fontPath = fileURLToPath(new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url));
  PImage.registerFont(fontPath, FONT_FAMILY).loadSync();
  fontReady = true;
} catch (e) {
  console.error('Font load failed, text will not render:', e?.message);
}

// ---------- palette ----------
export const COLORS = {
  green: '#34d399',
  amber: '#fbbf24',
  red: '#f87171',
  blue: '#4da3ff',
  purple: '#a78bfa',
  pink: '#f472b6',
  cyan: '#22d3ee',
  orange: '#fb923c',
  track: '#222b39',
  panel: '#151d29',
  text: '#f4f7fb',
  muted: '#8794a8',
  grid: '#2a3445',
};

function hex(c) {
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// ---------- minimal PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(data, w, h) {
  const rgba = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- canvas ----------
export class Canvas {
  constructor(size = SIZE) {
    this.s = size;
    this.img = PImage.make(size, size);
    this.ctx = this.img.getContext('2d');
    this.d = this.img.data;
  }

  px(x, y, rgb, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.s || y >= this.s) return;
    const i = (y * this.s + x) * 4;
    const d = this.d;
    const ia = 1 - a;
    d[i] = d[i] * ia + rgb[0] * a;
    d[i + 1] = d[i + 1] * ia + rgb[1] * a;
    d[i + 2] = d[i + 2] * ia + rgb[2] * a;
    d[i + 3] = 255;
  }

  background(top = '#151c27', bottom = '#0b0f15') {
    const a = hex(top);
    const b = hex(bottom);
    for (let y = 0; y < this.s; y++) {
      const t = y / (this.s - 1);
      const r = a[0] + (b[0] - a[0]) * t;
      const g = a[1] + (b[1] - a[1]) * t;
      const bl = a[2] + (b[2] - a[2]) * t;
      for (let x = 0; x < this.s; x++) {
        const i = (y * this.s + x) * 4;
        this.d[i] = r;
        this.d[i + 1] = g;
        this.d[i + 2] = bl;
        this.d[i + 3] = 255;
      }
    }
  }

  roundRect(x, y, w, h, r, color, alpha = 1) {
    const rgb = hex(color);
    r = Math.min(r, w / 2, h / 2);
    const x0 = Math.floor(x) - 1;
    const x1 = Math.ceil(x + w) + 1;
    const y0 = Math.floor(y) - 1;
    const y1 = Math.ceil(y + h) + 1;
    const cx = x + w / 2;
    const cy = y + h / 2;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const qx = Math.abs(px + 0.5 - cx) - (w / 2 - r);
        const qy = Math.abs(py + 0.5 - cy) - (h / 2 - r);
        const dist =
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
        this.px(px, py, rgb, clamp(0.5 - dist) * alpha);
      }
    }
  }

  // Arc ring with round caps. Angles in degrees, clockwise, 0 = 3 o'clock.
  ring(cx, cy, rad, th, startDeg, sweepDeg, color, alpha = 1) {
    if (sweepDeg <= 0) return;
    const rgb = hex(color);
    const half = th / 2;
    const rr = rad + half + 1;
    const toRad = Math.PI / 180;
    const p0x = cx + rad * Math.cos(startDeg * toRad);
    const p0y = cy + rad * Math.sin(startDeg * toRad);
    const p1x = cx + rad * Math.cos((startDeg + sweepDeg) * toRad);
    const p1y = cy + rad * Math.sin((startDeg + sweepDeg) * toRad);
    for (let py = Math.floor(cy - rr); py <= Math.ceil(cy + rr); py++) {
      for (let px = Math.floor(cx - rr); px <= Math.ceil(cx + rr); px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const dist = Math.hypot(dx, dy);
        let cov = 0;
        const radial = clamp(half + 0.5 - Math.abs(dist - rad));
        if (radial > 0) {
          let rel = (Math.atan2(dy, dx) / toRad - startDeg) % 360;
          if (rel < 0) rel += 360;
          if (rel <= sweepDeg) cov = radial;
        }
        const c0 = clamp(half + 0.5 - Math.hypot(px + 0.5 - p0x, py + 0.5 - p0y));
        const c1 = clamp(half + 0.5 - Math.hypot(px + 0.5 - p1x, py + 0.5 - p1y));
        cov = Math.max(cov, c0, c1);
        if (cov > 0) this.px(px, py, rgb, cov * alpha);
      }
    }
  }

  line(x0, y0, x1, y1, w, color, alpha = 1) {
    const rgb = hex(color);
    const half = w / 2;
    const minx = Math.floor(Math.min(x0, x1) - half - 1);
    const maxx = Math.ceil(Math.max(x0, x1) + half + 1);
    const miny = Math.floor(Math.min(y0, y1) - half - 1);
    const maxy = Math.ceil(Math.max(y0, y1) + half + 1);
    const vx = x1 - x0;
    const vy = y1 - y0;
    const len2 = vx * vx + vy * vy || 1;
    for (let py = miny; py <= maxy; py++) {
      for (let px = minx; px <= maxx; px++) {
        const t = clamp(((px + 0.5 - x0) * vx + (py + 0.5 - y0) * vy) / len2);
        const dist = Math.hypot(px + 0.5 - (x0 + t * vx), py + 0.5 - (y0 + t * vy));
        this.px(px, py, rgb, clamp(half + 0.5 - dist) * alpha);
      }
    }
  }

  // Filled triangle (4x4 supersampled) pointing up or down.
  triangle(cx, cy, size, dir, color) {
    const rgb = hex(color);
    const h = size * 0.9;
    const pts =
      dir === 'down'
        ? [[cx - size / 2, cy - h / 2], [cx + size / 2, cy - h / 2], [cx, cy + h / 2]]
        : [[cx - size / 2, cy + h / 2], [cx + size / 2, cy + h / 2], [cx, cy - h / 2]];
    const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    for (let py = Math.floor(cy - h); py <= Math.ceil(cy + h); py++) {
      for (let px = Math.floor(cx - size); px <= Math.ceil(cx + size); px++) {
        let hit = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            const p = [px + (sx + 0.5) / 4, py + (sy + 0.5) / 4];
            const d1 = sign(p, pts[0], pts[1]);
            const d2 = sign(p, pts[1], pts[2]);
            const d3 = sign(p, pts[2], pts[0]);
            const neg = d1 < 0 || d2 < 0 || d3 < 0;
            const pos = d1 > 0 || d2 > 0 || d3 > 0;
            if (!(neg && pos)) hit++;
          }
        }
        this.px(px, py, rgb, hit / 16);
      }
    }
  }

  // History graph (area + line). `values` newest last. `max` = full scale.
  graph(x, y, w, h, values, max, color, slots = 60) {
    const rgb = hex(color);
    const n = values.length;
    // faint mid grid line
    this.line(x, y + h / 2, x + w, y + h / 2, 1, COLORS.grid, 0.6);
    if (n < 2) return;
    const step = w / (slots - 1);
    const pts = values.map((v, i) => {
      const px = x + w - (n - 1 - i) * step;
      const py = y + h - clamp(v / max) * h;
      return [px, py];
    });
    // area fill, column by column
    for (let col = Math.ceil(pts[0][0]); col <= Math.floor(x + w); col++) {
      // locate segment
      let k = 0;
      while (k < pts.length - 2 && pts[k + 1][0] < col) k++;
      const [ax, ay] = pts[k];
      const [bx, by] = pts[k + 1];
      const t = bx === ax ? 0 : clamp((col - ax) / (bx - ax));
      const yy = ay + (by - ay) * t;
      const top = Math.max(y, yy);
      for (let py = Math.floor(top); py < y + h; py++) {
        const cover = py < top ? 1 - (top - py) : 1;
        const g = 0.38 * (1 - (py - y) / h) + 0.06;
        this.px(col, py, rgb, clamp(cover) * g);
      }
    }
    for (let i = 1; i < pts.length; i++) {
      this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 2.2, color, 1);
    }
  }

  // ----- text -----
  setFont(px) {
    this.ctx.font = `${px}pt ${FONT_FAMILY}`;
  }
  measure(text, px) {
    if (!fontReady) return 0;
    this.setFont(px);
    return this.ctx.measureText(String(text)).width;
  }
  text(text, x, y, px, color, align = 'left') {
    if (!fontReady || text == null || text === '') return;
    const s = String(text);
    const w = this.measure(s, px);
    let ox = x;
    if (align === 'center') ox = x - w / 2;
    else if (align === 'right') ox = x - w;
    this.ctx.fillStyle = color;
    this.setFont(px);
    this.ctx.fillText(s, ox, y);
  }
  // number + smaller unit rendered as one centered/left/right group
  valueUnit(num, unit, x, y, numPx, unitPx, color, unitColor, align = 'center') {
    const wn = this.measure(num, numPx);
    const gap = unit ? 2 : 0;
    const wu = unit ? this.measure(unit, unitPx) : 0;
    const total = wn + gap + wu;
    let ox = x;
    if (align === 'center') ox = x - total / 2;
    else if (align === 'right') ox = x - total;
    this.text(num, ox, y, numPx, color);
    if (unit) this.text(unit, ox + wn + gap, y, unitPx, unitColor || color);
  }

  toDataURL() {
    return 'data:image/png;base64,' + encodePNG(this.d, this.s, this.s).toString('base64');
  }
  toPNG() {
    return encodePNG(this.d, this.s, this.s);
  }
}

// ---------- helpers ----------
export function levelColor(pct, warn, crit, invert = false) {
  if (pct == null) return COLORS.muted;
  if (invert) {
    // low is bad (battery)
    if (pct <= crit) return COLORS.red;
    if (pct <= warn) return COLORS.amber;
    return COLORS.green;
  }
  if (pct >= crit) return COLORS.red;
  if (pct >= warn) return COLORS.amber;
  return COLORS.green;
}

export function resolveColor(setting, pct, warn, crit, invert = false) {
  if (setting && setting !== 'auto' && COLORS[setting]) return COLORS[setting];
  return levelColor(pct, warn, crit, invert);
}

function fitText(c, text, px, maxW) {
  let size = px;
  while (size > 8 && c.measure(text, size) > maxW) size -= 1;
  return size;
}

function ellipsize(c, text, px, maxW) {
  let t = String(text);
  if (c.measure(t, px) <= maxW) return t;
  while (t.length > 1 && c.measure(t + '…', px) > maxW) t = t.slice(0, -1);
  return t + '…';
}

// ---------- scenes ----------

// Ring gauge. value = 0..100 or null (N/A)
export function sceneRing({ label, value, num, unit = '', sub = '', color, naText = 'N/A', max = 100 }) {
  const c = new Canvas();
  c.background();
  const cx = 72;
  const cy = 68;
  const START = 135;
  const SWEEP = 270;
  c.ring(cx, cy, 52, 12, START, SWEEP, COLORS.track);
  if (value != null) c.ring(cx, cy, 52, 12, START, (SWEEP * clamp(value / max)), color);

  const lp = fitText(c, label, 13, 74);
  c.text(label, cx, 49, lp, COLORS.muted, 'center');
  if (value == null) {
    c.text(naText, cx, 89, fitText(c, naText, 26, 78), COLORS.muted, 'center');
  } else {
    const numPx = num.length > 3 || unit === '°C' ? 33 : 38;
    c.valueUnit(num, unit, cx, 89, numPx, 15, COLORS.text, COLORS.muted);
  }
  if (sub) {
    const px = fitText(c, sub, 13, 132);
    c.text(sub, cx, 137, px, COLORS.muted, 'center');
  }
  return c;
}

// Big number + history graph
export function sceneGraph({ label, value, num, unit = '', sub = '', color, history, max = 100, naText = 'N/A' }) {
  const c = new Canvas();
  c.background();
  const labelPx = fitText(c, label, 13, 70);
  c.text(label, 10, 22, labelPx, COLORS.muted, 'left');
  if (sub) {
    const room = 134 - 10 - c.measure(label, labelPx) - 8;
    const px = fitText(c, sub, 11, Math.max(30, room));
    c.text(sub, 134, 22, px, COLORS.muted, 'right');
  }
  if (value == null) {
    c.text(naText, 10, 68, fitText(c, naText, 30, 124), COLORS.muted, 'left');
  } else {
    c.valueUnit(num, unit, 10, 68, 42, 17, COLORS.text, COLORS.muted, 'left');
  }
  c.roundRect(6, 80, 132, 58, 8, COLORS.panel);
  c.graph(10, 86, 124, 46, history.filter((v) => v != null), max, color);
  return c;
}

// Network: down + up rows with sparklines
export function sceneNet({ down, up, histDown, histUp, unitMode, label = 'NETWORK', tags = null, floor = 100 * 1024 }) {
  const c = new Canvas();
  c.background();
  c.text(label, 10, 19, 12, COLORS.muted, 'left');
  const rows = [
    { y: 24, dir: 'down', rate: down, hist: histDown, color: COLORS.green },
    { y: 82, dir: 'up', rate: up, hist: histUp, color: COLORS.blue },
  ];
  const all = [...histDown, ...histUp];
  const maxHist = Math.max(floor, ...all);
  for (const r of rows) {
    if (tags) c.text(r.dir === 'down' ? tags[0] : tags[1], 9, r.y + 29, 22, r.color, 'left');
    else c.triangle(16, r.y + 20, 11, r.dir, r.color);
    if (r.rate == null) {
      c.text('N/A', tags ? 38 : 30, r.y + 29, 24, COLORS.muted, 'left');
    } else {
      c.valueUnit(r.rate.num, r.rate.unit, tags ? 38 : 30, r.y + 29, tags ? 23 : 25, 12, COLORS.text, COLORS.muted, 'left');
    }
    c.roundRect(8, r.y + 36, 128, 16, 5, COLORS.panel);
    c.graph(10, r.y + 38, 124, 12, r.hist, maxHist, r.color);
  }
  return c;
}

// Overview / list: up to 3 horizontal bars, optional title
export function sceneOverview({ rows, title = '' }) {
  const c = new Canvas();
  c.background();
  const ys = title ? [22, 60, 98] : [10, 55, 100];
  if (title) c.text(title, 10, 16, 12, COLORS.muted, 'left');
  rows.slice(0, 3).forEach((r, i) => {
    const y = ys[i];
    const vw = c.measure(r.text, 17);
    const room = Math.max(30, 124 - vw - 14);
    const lp = Math.max(11, fitText(c, r.label, 14, room));
    c.text(ellipsize(c, r.label, lp, room), 10, y + 17, lp, COLORS.muted, 'left');
    c.text(r.text, 134, y + 17, 17, r.value == null ? COLORS.muted : COLORS.text, 'right');
    c.roundRect(10, y + 25, 124, 10, 5, COLORS.track);
    if (r.value != null) {
      const w = Math.max(10, 124 * clamp(r.value / 100));
      c.roundRect(10, y + 25, w, 10, 5, r.color);
    }
  });
  return c;
}

// Big text only (uptime etc.)
export function sceneBig({ label, text, sub = '', color }) {
  const c = new Canvas();
  c.background();
  c.text(label, 72, 34, 14, COLORS.muted, 'center');
  const px = fitText(c, text, 40, 128);
  c.text(text, 72, 84, px, color, 'center');
  c.roundRect(46, 98, 52, 5, 2.5, color, 0.7);
  if (sub) {
    const sp = fitText(c, sub, 13, 132);
    c.text(sub, 72, 128, sp, COLORS.muted, 'center');
  }
  return c;
}

// Per-core CPU bars. `colors` is one color per value.
export function sceneCores({ label, values, colors, avg }) {
  const c = new Canvas();
  c.background();
  const avgText = `${Math.round(avg)}%`;
  const room = 124 - c.measure(avgText, 19) - 10;
  c.text(label, 10, 24, fitText(c, label, 13, room), COLORS.muted, 'left');
  c.text(avgText, 134, 25, 19, COLORS.text, 'right');
  let vals = values;
  let cols = colors;
  const MAX = 16;
  if (vals.length > MAX) {
    const per = vals.length / MAX;
    vals = [];
    cols = [];
    for (let i = 0; i < MAX; i++) {
      const slice = values.slice(Math.floor(i * per), Math.floor((i + 1) * per));
      const v = slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
      vals.push(v);
      cols.push(colors[Math.min(colors.length - 1, Math.floor(i * per))]);
    }
  }
  const n = vals.length || 1;
  const x0 = 10;
  const W = 124;
  const y0 = 38;
  const H = 96;
  const gap = n > 12 ? 2 : 4;
  const bw = (W - gap * (n - 1)) / n;
  const r = Math.min(4, bw / 2);
  vals.forEach((v, i) => {
    const x = x0 + i * (bw + gap);
    c.roundRect(x, y0, bw, H, r, COLORS.track);
    const h = Math.max(r * 2, H * clamp(v / 100));
    c.roundRect(x, y0 + H - h, bw, h, r, cols[i]);
  });
  return c;
}
