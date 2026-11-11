// One Monitor instance per key on the deck. It owns the key's settings,
// its own history buffer, and knows how to draw itself.

import path from 'node:path';
import {
  COLORS,
  resolveColor,
  sceneRing,
  sceneGraph,
  sceneNet,
  sceneOverview,
  sceneBig,
  sceneCores,
} from './render.js';
import { formatUsage, formatRate, normalizeDiskPath, PLATFORM } from './metrics.js';

export const TYPES = ['cpu', 'mem', 'disk', 'net', 'gpu', 'temp', 'overview', 'ping', 'uptime', 'battery', 'diskio', 'top', 'cores', 'dashboard'];

const TYPE_DEFAULTS = {
  cpu: { interval: 1, warn: 70, crit: 90 },
  mem: { interval: 2, warn: 70, crit: 90 },
  disk: { interval: 10, warn: 80, crit: 95 },
  net: { interval: 2, warn: 70, crit: 90 },
  gpu: { interval: 3, warn: 70, crit: 90 },
  temp: { interval: 3, warn: 70, crit: 85 },
  overview: { interval: 2, warn: 70, crit: 90 },
  ping: { interval: 2, warn: 80, crit: 150 },
  uptime: { interval: 30, warn: 0, crit: 0 },
  battery: { interval: 15, warn: 30, crit: 15 },
  diskio: { interval: 3, warn: 0, crit: 0 },
  top: { interval: 5, warn: 0, crit: 0 },
  cores: { interval: 1, warn: 70, crit: 90 },
  dashboard: { interval: 2, warn: 70, crit: 90 },
};

const HISTORY = 60;
const push = (arr, v) => {
  arr.push(v);
  if (arr.length > HISTORY) arr.shift();
};
const pctNum = (v) => String(Math.round(Math.min(100, Math.max(0, v))));

function diskLabel(p) {
  if (PLATFORM.IS_WIN) return `DISK ${p.slice(0, 2)}`;
  if (p === '/') return 'DISK /';
  return `DISK ${path.basename(p) || p}`;
}

export class Monitor {
  constructor(context, type, $UD, metrics) {
    this.context = context;
    this.type = TYPES.includes(type) ? type : 'cpu';
    this.$UD = $UD;
    this.metrics = metrics;
    this.settings = {};
    this.active = true;
    this.busy = false;
    this.lastAt = 0;
    this.lastImage = '';
    this.lastError = '';
    this.styleOverride = null;
    this.sortOverride = null;
    this.hist = [];
    this.histDown = [];
    this.histUp = [];
    this.update({});
  }

  // ---- settings ----
  update(raw) {
    const d = TYPE_DEFAULTS[this.type];
    const s = raw || {};
    const num = (v, fallback, min, max) => {
      const n = parseFloat(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };
    const next = {
      style: s.style === 'graph' ? 'graph' : 'ring',
      color: s.color || 'auto',
      interval: num(s.interval, d.interval, 1, 60),
      warn: num(s.warn, d.warn, 1, 200),
      crit: num(s.crit, d.crit, 1, 200),
      path: s.path || '',
      iface: s.iface || '',
      unit: s.unit === 'bits' ? 'bits' : 'bytes',
      source: s.source === 'gpu' ? 'gpu' : 'cpu',
      label: String(s.label || '').slice(0, 10),
      host: String(s.host || '').trim() || '1.1.1.1',
      sort: s.sort === 'mem' ? 'mem' : 'cpu',
      // Uptime has nothing to toggle, so it opens the dashboard unless told otherwise
      press: s.press ? (s.press === 'dashboard' ? 'dashboard' : 'toggle') : this.type === 'uptime' ? 'dashboard' : 'toggle',
      lhm: String(s.lhm || '').trim(),
    };
    if (this.type === 'battery') {
      if (next.crit >= next.warn) next.crit = Math.max(1, next.warn - 1);
    } else if (next.crit <= next.warn) next.crit = next.warn + 1;
    const histKey = `${next.path}|${next.iface}|${next.source}|${next.host}|${next.sort}`;
    if (this.histKey !== undefined && this.histKey !== histKey) {
      this.hist = [];
      this.histDown = [];
      this.histUp = [];
    }
    this.histKey = histKey;
    this.settings = next;
    this.styleOverride = null;
    this.sortOverride = null;
    this.lastImage = '';
  }

  get style() {
    return this.styleOverride || this.settings.style;
  }

  get sort() {
    return this.sortOverride || this.settings.sort;
  }

  toggleStyle() {
    // Top Process: switch between CPU and RAM ranking
    if (this.type === 'top') {
      this.sortOverride = this.sort === 'cpu' ? 'mem' : 'cpu';
      this.lastImage = '';
      return;
    }
    if (['net', 'overview', 'uptime', 'diskio', 'cores', 'dashboard'].includes(this.type)) return;
    this.styleOverride = this.style === 'ring' ? 'graph' : 'ring';
    this.lastImage = '';
  }

  setActive(active) {
    this.active = !!active;
    if (this.active) {
      this.lastImage = '';
      this.refresh();
    }
  }

  // ---- scheduling ----
  tick(now) {
    if (!this.active) return;
    if (now - this.lastAt < this.settings.interval * 1000 - 60) return;
    this.refresh();
  }

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    this.lastAt = Date.now();
    try {
      const canvas = await this.build();
      const url = canvas.toDataURL();
      if (url !== this.lastImage) {
        this.lastImage = url;
        this.$UD.setBaseDataIcon(this.context, url);
      }
      this.lastError = '';
    } catch (err) {
      const msg = String(err?.stack || err);
      if (msg !== this.lastError) {
        this.lastError = msg;
        this.$UD.logMessage(`[${this.type}] render error: ${msg}`, 'error');
      }
    } finally {
      this.busy = false;
    }
  }

  // ---- drawing ----
  async build() {
    const { warn, crit } = this.settings;
    const label = (def) => (this.settings.label ? this.settings.label.toUpperCase() : def);

    if (this.type === 'net') return this.buildNet(label('NETWORK'));
    if (this.type === 'overview') return this.buildOverview();
    if (this.type === 'uptime') return this.buildUptime(label('UPTIME'));
    if (this.type === 'diskio') return this.buildDiskIO(label('DISK I/O'));
    if (this.type === 'top') return this.buildTop(label(this.sort === 'mem' ? 'TOP RAM' : 'TOP CPU'));
    if (this.type === 'cores') return this.buildCores(label('CPU CORES'));

    // single-value types -> common spec
    let spec;
    switch (this.type) {
      case 'dashboard': {
        const m = await this.metrics.cpu();
        spec = {
          label: label('DASHBOARD'),
          value: m.usage,
          num: pctNum(m.usage),
          unit: '%',
          sub: 'tap to open',
        };
        break;
      }
      case 'cpu': {
        const m = await this.metrics.cpu();
        spec = {
          label: label('CPU'),
          value: m.usage,
          num: pctNum(m.usage),
          unit: '%',
          sub: `${m.cores} thread${m.cores === 1 ? '' : 's'}`,
        };
        break;
      }
      case 'mem': {
        const m = await this.metrics.mem();
        spec = {
          label: label('RAM'),
          value: m.pct,
          num: pctNum(m.pct),
          unit: '%',
          sub: formatUsage(m.used, m.total),
        };
        break;
      }
      case 'disk': {
        const p = normalizeDiskPath(this.settings.path);
        let m = null;
        try {
          m = await this.metrics.disk(p);
        } catch (_) {
          m = null;
        }
        spec = m
          ? {
              label: label(diskLabel(p)),
              value: m.pct,
              num: pctNum(m.pct),
              unit: '%',
              sub: formatUsage(m.used, m.total),
            }
          : { label: label(diskLabel(p)), value: null, sub: 'Path not found', naText: 'N/A' };
        break;
      }
      case 'gpu': {
        const g = await this.metrics.gpu();
        if (g && g.util != null) {
          let sub = g.name;
          if (g.memUsed != null && g.memTotal) {
            sub = `${(g.memUsed / 1024).toFixed(1)} / ${(g.memTotal / 1024).toFixed(0)} GB`;
          } else if (g.temp != null) {
            sub = `${Math.round(g.temp)}°C`;
          }
          spec = { label: label('GPU'), value: g.util, num: pctNum(g.util), unit: '%', sub };
        } else {
          spec = {
            label: label('GPU'),
            value: null,
            sub: g ? 'No usage data' : 'No GPU info',
            naText: 'N/A',
          };
        }
        break;
      }
      case 'temp': {
        const src = this.settings.source;
        let t = null;
        let sub = '';
        if (src === 'gpu') {
          const g = await this.metrics.gpu();
          t = g?.temp ?? null;
          if (t != null) sub = g.name;
          else {
            t = await this.metrics.lhmTemp('gpu', this.settings.lhm);
            sub = t == null ? 'No GPU sensor' : 'LibreHW Monitor';
          }
        } else {
          t = await this.metrics.cpuTemp();
          if (t != null) sub = 'Package';
          else {
            t = await this.metrics.lhmTemp('cpu', this.settings.lhm);
            sub = t == null ? 'No sensor access' : 'LibreHW Monitor';
          }
        }
        spec = {
          label: label(src === 'gpu' ? 'GPU TEMP' : 'CPU TEMP'),
          value: t,
          num: t == null ? '' : String(Math.round(t)),
          unit: '°C',
          sub,
          naText: 'N/A',
        };
        break;
      }
      case 'ping': {
        const r = await this.metrics.ping(this.settings.host);
        const host = this.settings.host;
        if (r?.invalid) {
          spec = { label: label('PING'), value: null, sub: 'Invalid host', naText: 'N/A' };
        } else if (r && r.ms != null) {
          const ms = r.ms;
          spec = {
            label: label('PING'),
            value: ms,
            num: ms < 10 ? ms.toFixed(1) : String(Math.round(ms)),
            unit: 'ms',
            sub: host,
            max: 200,
          };
        } else {
          spec = { label: label('PING'), value: null, sub: host, naText: 'Timeout', max: 200 };
          // keep the graph honest: record a full-scale spike on timeout
          push(this.hist, 200);
        }
        break;
      }
      case 'battery': {
        const b = await this.metrics.battery();
        if (b && b.has) {
          let sub = 'On battery';
          if (b.charging) sub = 'Charging';
          else if (b.ac) sub = 'Plugged in';
          else if (b.remaining) sub = `${Math.floor(b.remaining / 60)}h ${b.remaining % 60}m left`;
          spec = {
            label: label('BATTERY'),
            value: b.percent,
            num: pctNum(b.percent),
            unit: '%',
            sub,
            charging: b.charging,
          };
        } else {
          spec = { label: label('BATTERY'), value: null, sub: 'No battery', naText: 'N/A' };
        }
        break;
      }
      default:
        throw new Error(`unknown type ${this.type}`);
    }

    if (spec.value != null) push(this.hist, spec.value);
    const invert = this.type === 'battery';
    let color = resolveColor(this.settings.color, spec.value, warn, crit, invert);
    if (spec.charging && this.settings.color === 'auto') color = COLORS.cyan;

    if (this.style === 'graph' || this.type === 'dashboard') {
      return sceneGraph({ ...spec, color, history: this.hist, max: spec.max || 100 });
    }
    return sceneRing({ ...spec, color });
  }

  buildUptime(label) {
    const sec = Math.floor(this.metrics.uptime());
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    const boot = new Date(Date.now() - sec * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const sub = `since ${pad(boot.getDate())}/${pad(boot.getMonth() + 1)} ${pad(boot.getHours())}:${pad(boot.getMinutes())}`;
    const color = this.settings.color === 'auto' ? COLORS.blue : resolveColor(this.settings.color, 0, 1, 2);
    return sceneBig({ label, text, sub, color });
  }

  async buildDiskIO(label) {
    const io = await this.metrics.diskIO();
    if (!io) {
      return sceneNet({ down: null, up: null, histDown: this.histDown, histUp: this.histUp, unitMode: 'bytes', label, tags: ['R', 'W'] });
    }
    push(this.histDown, io.read);
    push(this.histUp, io.write);
    return sceneNet({
      down: formatRate(io.read, 'bytes'),
      up: formatRate(io.write, 'bytes'),
      histDown: this.histDown,
      histUp: this.histUp,
      unitMode: 'bytes',
      label,
      tags: ['R', 'W'],
      floor: 1024 * 1024,
    });
  }

  async buildTop(title) {
    const data = await this.metrics.topProcs();
    const byMem = this.sort === 'mem';
    const accent = this.settings.color === 'auto' ? (byMem ? COLORS.purple : COLORS.orange) : resolveColor(this.settings.color, 0, 1, 2);
    if (!data || !data.list.length) {
      return sceneOverview({ title, rows: [{ label: 'No data', value: null, text: 'N/A', color: accent }] });
    }
    const top = [...data.list].sort((a, b) => (byMem ? b.mem - a.mem : b.cpu - a.cpu)).slice(0, 3);
    const peak = byMem ? top[0].mem : Math.max(top[0].cpu, 1);
    const rows = top.map((p) => {
      const v = byMem ? p.mem : p.cpu;
      let text;
      if (byMem) {
        const mb = p.mem / 1048576;
        text = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
      } else {
        text = `${p.cpu >= 10 ? Math.round(p.cpu) : p.cpu.toFixed(1)}%`;
      }
      return { label: p.name.replace(/\.exe$/i, ''), value: peak > 0 ? (v / peak) * 100 : 0, text, color: accent };
    });
    return sceneOverview({ title, rows });
  }

  async buildCores(label) {
    const vals = await this.metrics.cores();
    if (!vals || !vals.length) return sceneOverview({ rows: [{ label: 'CPU', value: null, text: 'N/A', color: COLORS.muted }] });
    const { warn, crit, color } = this.settings;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const colors = vals.map((v) => resolveColor(color, v, warn, crit));
    return sceneCores({ label, values: vals, colors, avg });
  }

  async buildNet(label) {
    const n = await this.metrics.net(this.settings.iface);
    const mode = this.settings.unit;
    if (!n) {
      return sceneNet({ down: null, up: null, histDown: this.histDown, histUp: this.histUp, unitMode: mode, label });
    }
    push(this.histDown, n.down);
    push(this.histUp, n.up);
    return sceneNet({
      down: formatRate(n.down, mode),
      up: formatRate(n.up, mode),
      histDown: this.histDown,
      histUp: this.histUp,
      unitMode: mode,
      label,
    });
  }

  async buildOverview() {
    const { warn, crit, color: colorSetting } = this.settings;
    const [cpu, mem] = await Promise.all([this.metrics.cpu(), this.metrics.mem()]);
    let disk = null;
    try {
      disk = await this.metrics.disk(this.settings.path);
    } catch (_) {
      disk = null;
    }
    const row = (label, v) => ({
      label,
      value: v,
      text: v == null ? 'N/A' : `${pctNum(v)}%`,
      color: resolveColor(colorSetting, v, warn, crit),
    });
    return sceneOverview({
      rows: [row('CPU', cpu?.usage ?? null), row('RAM', mem?.pct ?? null), row('DISK', disk?.pct ?? null)],
    });
  }
}

export { COLORS };
