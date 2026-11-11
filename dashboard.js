// Local web dashboard.
//  - HTTP server bound to 127.0.0.1 only (not reachable from other machines)
//  - Server-Sent Events stream with live snapshots (only collected while a
//    browser tab is actually open and visible)
//  - Dashboard settings persisted in the user's home folder so they survive
//    plugin updates.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 39170;
const HISTORY_MS = 10 * 60 * 1000;
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const SETTINGS_DIR = path.join(os.homedir(), '.ulanzi-system-monitor');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'dashboard.json');

export const CARD_IDS = ['cpu', 'mem', 'disk', 'io', 'net', 'gpu', 'temp', 'ping', 'battery', 'uptime', 'procs'];

export const DEFAULT_SETTINGS = {
  title: 'System Monitor',
  theme: 'dark', // dark | light | amoled | auto
  accent: '#4da3ff',
  colorMode: 'auto', // auto (by level / per card) | accent
  chartStyle: 'area', // area | line | bars
  density: 'comfortable', // comfortable | compact
  columns: 'auto', // auto | 1 | 2 | 3 | 4
  fontScale: 100,
  refresh: 1, // seconds
  window: 120, // seconds shown in charts
  netUnit: 'bytes', // bytes | bits
  tempUnit: 'C', // C | F
  disk: '',
  host: '1.1.1.1',
  iface: '',
  lhm: '',
  warn: { pct: 70, temp: 70, ping: 80 },
  crit: { pct: 90, temp: 85, ping: 150 },
  cards: CARD_IDS.map((id) => ({ id, show: true })),
};

const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const num = (v, min, max, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const str = (v, max, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);

export function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const s = input && typeof input === 'object' ? input : {};
  const d = base;
  const out = {
    title: str(s.title, 40, d.title) || d.title,
    theme: pick(s.theme, ['dark', 'light', 'amoled', 'auto'], d.theme),
    accent: /^#[0-9a-fA-F]{6}$/.test(s.accent) ? s.accent : d.accent,
    colorMode: pick(s.colorMode, ['auto', 'accent'], d.colorMode),
    chartStyle: pick(s.chartStyle, ['area', 'line', 'bars'], d.chartStyle),
    density: pick(s.density, ['comfortable', 'compact'], d.density),
    columns: pick(String(s.columns), ['auto', '1', '2', '3', '4'], d.columns),
    fontScale: num(s.fontScale, 80, 160, d.fontScale),
    refresh: pick(Number(s.refresh), [1, 2, 3, 5], d.refresh),
    window: pick(Number(s.window), [60, 120, 300, 600], d.window),
    netUnit: pick(s.netUnit, ['bytes', 'bits'], d.netUnit),
    tempUnit: pick(s.tempUnit, ['C', 'F'], d.tempUnit),
    disk: str(s.disk, 200, d.disk),
    host: /^[A-Za-z0-9][A-Za-z0-9.\-:]{0,100}$/.test(str(s.host, 101)) ? str(s.host, 101) : d.host,
    iface: str(s.iface, 80, d.iface),
    lhm: /^(https?:\/\/[^\s]{1,200})?$/.test(str(s.lhm, 200)) ? str(s.lhm, 200) : d.lhm,
    warn: {
      pct: num(s.warn?.pct, 1, 200, d.warn.pct),
      temp: num(s.warn?.temp, 1, 200, d.warn.temp),
      ping: num(s.warn?.ping, 1, 5000, d.warn.ping),
    },
    crit: {
      pct: num(s.crit?.pct, 1, 200, d.crit.pct),
      temp: num(s.crit?.temp, 1, 200, d.crit.temp),
      ping: num(s.crit?.ping, 1, 5000, d.crit.ping),
    },
    cards: [],
  };
  // cards: keep valid ids, in the given order, and append any that are missing
  const seen = new Set();
  for (const c of Array.isArray(s.cards) ? s.cards : []) {
    if (c && CARD_IDS.includes(c.id) && !seen.has(c.id)) {
      seen.add(c.id);
      out.cards.push({ id: c.id, show: c.show !== false });
    }
  }
  for (const id of CARD_IDS) if (!seen.has(id)) out.cards.push({ id, show: true });
  for (const k of ['pct', 'temp', 'ping']) {
    if (out.crit[k] <= out.warn[k]) out.crit[k] = out.warn[k] + 1;
  }
  return out;
}

function loadSettings() {
  try {
    return sanitizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch (_) {
    return sanitizeSettings({});
  }
}

export class Dashboard {
  constructor(metrics, log = () => {}) {
    this.metrics = metrics;
    this.log = log;
    this.settings = loadSettings();
    this.clients = new Set();
    this.history = [];
    this.timer = null;
    this.sampling = false;
    this.port = null;
    this.server = null;
    this.html = null;
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}/` : null;
  }

  // ---------- lifecycle ----------
  async start() {
    for (let i = 0; i < 25; i++) {
      const port = DEFAULT_PORT + i;
      try {
        await this.listen(port);
        this.port = port;
        this.log(`Dashboard listening on ${this.url}`);
        return this.url;
      } catch (err) {
        if (err?.code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error('No free port for dashboard');
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.on('error', (e) => this.log(`dashboard server error: ${e?.message}`));
        this.server = server;
        resolve();
      });
    });
  }

  stop() {
    clearTimeout(this.timer);
    for (const c of this.clients) {
      try {
        c.end();
      } catch (_) {
        /* ignore */
      }
    }
    this.clients.clear();
    this.server?.close();
  }

  // ---------- HTTP ----------
  hostOk(req) {
    // blocks DNS-rebinding: only accept requests addressed to localhost
    return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(req.headers.host || ''));
  }

  send(res, code, body, type = 'application/json; charset=utf-8') {
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  async handle(req, res) {
    try {
      if (!this.hostOk(req)) return this.send(res, 403, '{"error":"forbidden"}');
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        if (!this.html || process.env.SM_DEBUG === '1') {
          this.html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
        }
        return this.send(res, 200, this.html, 'text/html; charset=utf-8');
      }
      if (url.pathname === '/favicon.ico') return this.send(res, 204, '');

      if (req.method === 'GET' && url.pathname === '/api/stream') return this.stream(req, res);

      if (req.method === 'GET' && url.pathname === '/api/settings') {
        return this.send(res, 200, JSON.stringify(this.settings));
      }

      if (req.method === 'POST' && (url.pathname === '/api/settings' || url.pathname === '/api/reset')) {
        // Cross-origin pages cannot send application/json without a preflight
        // (which we never answer), so this also protects against CSRF.
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) return this.send(res, 403, '{"error":"origin"}');
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
          return this.send(res, 415, '{"error":"json only"}');
        }
        const body = await this.readBody(req, 20000);
        const next =
          url.pathname === '/api/reset' ? sanitizeSettings({}) : sanitizeSettings(JSON.parse(body || '{}'), this.settings);
        this.settings = next;
        this.saveSettings();
        this.broadcast('settings', next);
        this.restartLoop();
        return this.send(res, 200, JSON.stringify(next));
      }

      this.send(res, 404, '{"error":"not found"}');
    } catch (err) {
      this.log(`dashboard request error: ${err?.message}`);
      try {
        this.send(res, 400, '{"error":"bad request"}');
      } catch (_) {
        /* ignore */
      }
    }
  }

  readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  saveSettings() {
    try {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      this.log(`could not save dashboard settings: ${err?.message}`);
    }
  }

  // ---------- SSE ----------
  stream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const info = {
      host: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      cpuModel: (os.cpus()[0]?.model || 'CPU').replace(/\s+/g, ' ').trim(),
      threads: os.cpus().length,
      port: this.port,
    };
    this.write(res, 'hello', { settings: this.settings, info, history: this.history });
    this.clients.add(res);
    req.on('close', () => {
      this.clients.delete(res);
      if (!this.clients.size) clearTimeout(this.timer);
    });
    if (this.clients.size === 1) this.restartLoop();
  }

  write(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event, data) {
    for (const c of this.clients) {
      try {
        this.write(c, event, data);
      } catch (_) {
        this.clients.delete(c);
      }
    }
  }

  restartLoop() {
    clearTimeout(this.timer);
    if (this.clients.size) this.loop();
  }

  async loop() {
    if (!this.clients.size) return;
    if (!this.sampling) {
      this.sampling = true;
      const t0 = Date.now();
      try {
        const snap = await this.sample();
        this.record(snap);
        this.broadcast('tick', snap);
      } catch (err) {
        this.log(`dashboard sample error: ${err?.message}`);
      } finally {
        this.sampling = false;
      }
      const wait = Math.max(150, this.settings.refresh * 1000 - (Date.now() - t0));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.loop(), wait);
    }
  }

  // ---------- sampling ----------
  async sample() {
    const m = this.metrics;
    const s = this.settings;
    const ok = (p) => p.catch(() => null);
    const [cpu, cores, mem, disk, io, net, gpu, ctemp, ping, bat, procs] = await Promise.all([
      ok(m.cpu()),
      ok(m.cores()),
      ok(m.mem()),
      ok(m.disk(s.disk)),
      ok(m.diskIO()),
      ok(m.net(s.iface)),
      ok(m.gpu()),
      ok(m.cpuTemp()),
      ok(m.ping(s.host)),
      ok(m.battery()),
      ok(m.topProcs()),
    ]);
    let cpuTemp = ctemp ?? null;
    let gpuTemp = gpu?.temp ?? null;
    if (cpuTemp == null) cpuTemp = (await ok(m.lhmTemp('cpu', s.lhm))) ?? null;
    if (gpuTemp == null) gpuTemp = (await ok(m.lhmTemp('gpu', s.lhm))) ?? null;

    let top = null;
    if (procs?.list) {
      const cut = (arr, key) =>
        [...arr]
          .sort((a, b) => b[key] - a[key])
          .slice(0, 6)
          .map((p) => ({ name: p.name.replace(/\.exe$/i, ''), cpu: p.cpu, mem: p.mem }));
      top = { cpu: cut(procs.list, 'cpu'), mem: cut(procs.list, 'mem'), totalMem: procs.totalMem };
    }

    return {
      t: Date.now(),
      cpu: cpu ? { usage: cpu.usage, threads: cpu.cores } : null,
      cores: cores || null,
      mem: mem || null,
      disk: disk || null,
      io: io || null,
      net: net || null,
      gpu: gpu ? { ...gpu, temp: gpuTemp } : null,
      temp: { cpu: cpuTemp, gpu: gpuTemp },
      ping: ping && !ping.invalid ? { ms: ping.ms, host: ping.host } : null,
      battery: bat || null,
      uptime: m.uptime(),
      procs: top,
    };
  }

  record(snap) {
    this.history.push({
      t: snap.t,
      cpu: snap.cpu?.usage ?? null,
      mem: snap.mem?.pct ?? null,
      down: snap.net?.down ?? null,
      up: snap.net?.up ?? null,
      gpu: snap.gpu?.util ?? null,
      ctemp: snap.temp.cpu,
      gtemp: snap.temp.gpu,
      ping: snap.ping ? snap.ping.ms : null,
      r: snap.io?.read ?? null,
      w: snap.io?.write ?? null,
      disk: snap.disk?.pct ?? null,
    });
    const cutoff = snap.t - HISTORY_MS;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();
  }
}
