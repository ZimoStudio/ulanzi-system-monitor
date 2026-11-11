// System metrics collector.
// Fast metrics (CPU / RAM / disk) use only Node built-ins.
// Slower metrics (network / GPU / temperature) use `systeminformation`
// and are cached + refreshed in the background so the UI never blocks.

import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import si from 'systeminformation';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout))
    );
  });
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export function normalizeDiskPath(input) {
  let p = String(input || '').trim();
  if (!p) return IS_WIN ? 'C:\\' : '/';
  if (IS_WIN) {
    // "c", "C:", "c:\" -> "C:\"
    const m = p.match(/^([a-zA-Z])(:)?[\\/]?$/);
    if (m) return `${m[1].toUpperCase()}:\\`;
  }
  return p;
}

export class Metrics {
  constructor() {
    this.cache = {};
    this.prevCpu = cpuTimes();
    this.lastCpu = 0;
    this.prevNet = {};
    this.defaultIface = null;
  }

  // Stale-while-revalidate cache with in-flight de-duplication.
  async cached(key, ttl, fn, { swr = false } = {}) {
    const e = (this.cache[key] ||= { t: 0, v: undefined, p: null });
    const now = Date.now();
    if (now - e.t < ttl) return e.v;
    if (!e.p) {
      e.p = Promise.resolve()
        .then(fn)
        .then((v) => {
          e.v = v;
          e.t = Date.now();
        })
        .catch(() => {
          // keep previous value, but back off so we don't hammer a failing call
          e.t = Date.now();
        })
        .finally(() => {
          e.p = null;
        });
    }
    if (swr && e.v !== undefined) return e.v;
    await e.p;
    return e.v;
  }

  // ---------- CPU ----------
  async cpu() {
    return this.cached('cpu', 900, async () => {
      if (!this.primed) {
        // first reading needs a real time window, otherwise it is noisy
        this.primed = true;
        await new Promise((r) => setTimeout(r, 600));
      }
      const cur = cpuTimes();
      const dIdle = cur.idle - this.prevCpu.idle;
      const dTotal = cur.total - this.prevCpu.total;
      this.prevCpu = cur;
      if (dTotal <= 0) return { usage: this.lastCpu, cores: os.cpus().length };
      const usage = Math.min(100, Math.max(0, 100 * (1 - dIdle / dTotal)));
      this.lastCpu = usage;
      return { usage, cores: os.cpus().length };
    });
  }

  // ---------- Memory ----------
  async mem() {
    return this.cached('mem', 900, async () => {
      const total = os.totalmem();
      let free = os.freemem();
      if (IS_MAC) {
        // os.freemem() on macOS ignores cache/inactive pages -> use `available`
        try {
          const m = await withTimeout(si.mem(), 4000);
          if (m && m.available) free = m.available;
        } catch (_) {
          /* fall back to os.freemem() */
        }
      }
      const used = Math.max(0, total - free);
      return { used, total, pct: (used / total) * 100 };
    });
  }

  // ---------- Disk ----------
  async disk(inputPath) {
    const p = normalizeDiskPath(inputPath);
    return this.cached(
      `disk:${p}`,
      5000,
      async () => {
        if (typeof fs.statfsSync === 'function') {
          const s = fs.statfsSync(p);
          const total = Number(s.blocks) * Number(s.bsize);
          const free = Number(s.bavail) * Number(s.bsize);
          const used = total - free;
          return { path: p, used, total, pct: total > 0 ? (used / total) * 100 : 0 };
        }
        const list = await withTimeout(si.fsSize(), 8000);
        const wanted = p.replace(/[\\/]+$/, '').toLowerCase();
        const hit =
          list.find((d) => String(d.mount).replace(/[\\/]+$/, '').toLowerCase() === wanted) ||
          list[0];
        return { path: p, used: hit.used, total: hit.size, pct: hit.use };
      },
      { swr: true }
    );
  }

  // ---------- Network ----------
  async net(ifaceSetting) {
    const wanted = (ifaceSetting || '').trim();
    return this.cached(
      `net:${wanted}`,
      1200,
      async () => {
        let target = wanted;
        if (!target || target.toLowerCase() === 'auto') {
          if (!this.defaultIface) {
            try {
              this.defaultIface = await withTimeout(si.networkInterfaceDefault(), 6000);
            } catch (_) {
              this.defaultIface = '';
            }
          }
          target = this.defaultIface || '*';
        }
        const stats = await withTimeout(si.networkStats(target), 8000);
        let rows = Array.isArray(stats) ? stats : [stats];
        if (target === '*') {
          rows = rows.filter((r) => r && r.operstate === 'up' && !/^lo/i.test(r.iface));
        }
        const rx = rows.reduce((a, r) => a + (Number(r.rx_bytes) || 0), 0);
        const tx = rows.reduce((a, r) => a + (Number(r.tx_bytes) || 0), 0);
        const now = Date.now();
        const key = target;
        const prev = this.prevNet[key];
        this.prevNet[key] = { t: now, rx, tx };
        const iface = rows[0]?.iface || target;
        if (!prev) return { down: 0, up: 0, iface };
        const dt = (now - prev.t) / 1000;
        if (dt <= 0) return { down: 0, up: 0, iface };
        const down = rx >= prev.rx ? (rx - prev.rx) / dt : 0;
        const up = tx >= prev.tx ? (tx - prev.tx) / dt : 0;
        return { down, up, iface };
      },
      { swr: true }
    );
  }

  // ---------- GPU ----------
  // 1) nvidia-smi (fast + accurate, NVIDIA only)
  // 2) Windows performance counters (any vendor, best effort)
  // 3) systeminformation (name / VRAM only, no usage)
  async gpu() {
    return this.cached('gpu', 4000, () => this.sampleGpu(), { swr: true });
  }

  async sampleGpu() {
    if (this.nvidia !== false) {
      try {
        const out = await run(
          'nvidia-smi',
          [
            '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name',
            '--format=csv,noheader,nounits',
          ],
          4000
        );
        const line = out.trim().split(/\r?\n/)[0];
        const [util, temp, used, total, ...nameParts] = line.split(',').map((x) => x.trim());
        const n = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
        this.nvidia = true;
        return {
          name: nameParts.join(',') || 'NVIDIA GPU',
          util: n(util),
          temp: n(temp),
          memUsed: n(used),
          memTotal: n(total),
        };
      } catch (_) {
        if (this.nvidia === undefined) this.nvidia = false; // not installed
      }
    }

    // generic info (name / vram) once
    if (!this.gpuInfo) {
      try {
        const g = await withTimeout(si.graphics(), 12000);
        const c = (g?.controllers || [])[0];
        if (c) {
          this.gpuInfo = {
            name: c.model || 'GPU',
            temp: c.temperatureGpu ?? null,
            memUsed: c.memoryUsed ?? null,
            memTotal: c.memoryTotal || c.vram || null,
          };
        }
      } catch (_) {
        /* ignore */
      }
    }
    const info = this.gpuInfo;

    if (IS_WIN && (this.winGpuFails || 0) < 3) {
      try {
        const out = await run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "(Get-Counter '\\GPU Engine(*engtype_3D*)\\Utilization Percentage').CounterSamples | Measure-Object CookedValue -Sum | Select-Object -ExpandProperty Sum",
          ],
          8000
        );
        const v = parseFloat(out.trim().replace(',', '.'));
        if (Number.isFinite(v)) {
          this.winGpuFails = 0;
          return { ...(info || { name: 'GPU' }), util: Math.min(100, Math.max(0, v)) };
        }
        this.winGpuFails = (this.winGpuFails || 0) + 1;
      } catch (_) {
        this.winGpuFails = (this.winGpuFails || 0) + 1;
      }
    }

    return info ? { ...info, util: null } : null;
  }

  // ---------- Per-core CPU ----------
  async cores() {
    return this.cached('cores', 900, async () => {
      const snap = () =>
        os.cpus().map((c) => {
          const t = c.times;
          return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
        });
      if (!this.prevCores) {
        this.prevCores = snap();
        await new Promise((r) => setTimeout(r, 600));
      }
      const cur = snap();
      const prev = this.prevCores;
      this.prevCores = cur;
      return cur.map((c, i) => {
        const dT = c.total - (prev[i]?.total ?? c.total);
        const dI = c.idle - (prev[i]?.idle ?? c.idle);
        return dT > 0 ? Math.min(100, Math.max(0, 100 * (1 - dI / dT))) : 0;
      });
    });
  }

  // ---------- Disk I/O (bytes/sec) ----------
  async diskIO() {
    return this.cached(
      'diskio',
      2500,
      async () => {
        if (IS_WIN) {
          // WMI property names are English on every Windows locale
          const out = await run(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object Name -eq '_Total' | Select-Object DiskReadBytesPerSec,DiskWriteBytesPerSec | ConvertTo-Json -Compress",
            ],
            8000
          );
          const j = JSON.parse(out.trim());
          return { read: Number(j.DiskReadBytesPerSec) || 0, write: Number(j.DiskWriteBytesPerSec) || 0 };
        }
        const st = await withTimeout(si.fsStats(), 6000);
        if (!st || st.rx_sec == null) return { read: 0, write: 0 };
        return { read: st.rx_sec || 0, write: st.wx_sec || 0 };
      },
      { swr: true }
    );
  }

  // ---------- Top processes (grouped by name) ----------
  async topProcs() {
    return this.cached(
      'procs',
      4000,
      async () => {
        const cores = os.cpus().length || 1;
        const groups = new Map();
        const add = (name, cpu, mem) => {
          const key = name || '?';
          const g = groups.get(key) || { name: key, cpu: 0, mem: 0 };
          g.cpu += cpu;
          g.mem += mem;
          groups.set(key, g);
        };
        if (IS_WIN) {
          const out = await run(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Select-Object Name,PercentProcessorTime,WorkingSetPrivate,WorkingSet | ConvertTo-Json -Compress",
            ],
            15000
          );
          let rows = JSON.parse(out.trim() || '[]');
          if (!Array.isArray(rows)) rows = [rows];
          for (const r of rows) {
            const name = String(r.Name || '').replace(/#\d+$/, '');
            add(name, (Number(r.PercentProcessorTime) || 0) / cores, Number(r.WorkingSetPrivate) || Number(r.WorkingSet) || 0);
          }
        } else {
          const out = await run('ps', ['-Ao', 'pcpu=,rss=,comm='], 8000);
          for (const line of out.split(/\r?\n/)) {
            const m = line.match(/^\s*([\d.]+)\s+(\d+)\s+(.+)$/);
            if (!m) continue;
            const base = m[3].trim().split('/').pop();
            add(base, (parseFloat(m[1]) || 0) / cores, (parseInt(m[2], 10) || 0) * 1024);
          }
        }
        return { list: [...groups.values()], totalMem: os.totalmem() };
      },
      { swr: true }
    );
  }

  // ---------- LibreHardwareMonitor (optional temps) ----------
  async lhmTemp(kind, url) {
    const target = (url || '').trim() || 'http://127.0.0.1:8085/data.json';
    const key = `lhm:${kind}:${target}`;
    return this.cached(
      key,
      3000,
      async () => {
        // back off for a while if LHM is not running
        if (this.lhmDownUntil?.[target] > Date.now()) return null;
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 1500);
          const res = await fetch(target, { signal: ctl.signal }).finally(() => clearTimeout(t));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          return findLhmTemp(json, kind);
        } catch (_) {
          (this.lhmDownUntil ||= {})[target] = Date.now() + 20000;
          return null;
        }
      },
      { swr: true }
    );
  }

  // ---------- Ping ----------
  async ping(host) {
    const h = String(host || '1.1.1.1').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9.\-:]*$/.test(h)) return { ms: null, host: h, invalid: true };
    return this.cached(
      `ping:${h}`,
      1500,
      async () => {
        const args = IS_WIN
          ? ['-n', '1', '-w', '1500', h]
          : IS_MAC
            ? ['-c', '1', '-t', '2', h]
            : ['-c', '1', '-W', '2', h];
        try {
          const out = await run('ping', args, 4000);
          const m = out.match(/(?:=|<)\s*(\d+(?:[.,]\d+)?)\s*ms/i);
          return { ms: m ? parseFloat(m[1].replace(',', '.')) : null, host: h };
        } catch (_) {
          return { ms: null, host: h };
        }
      },
      { swr: true }
    );
  }

  // ---------- Battery ----------
  async battery() {
    return this.cached(
      'battery',
      8000,
      async () => {
        const b = await withTimeout(si.battery(), 8000);
        if (!b || !b.hasBattery) return { has: false };
        return {
          has: true,
          percent: Number(b.percent),
          charging: !!b.isCharging,
          ac: !!b.acConnected,
          remaining: b.timeRemaining ?? null, // minutes
        };
      },
      { swr: true }
    );
  }

  uptime() {
    return os.uptime();
  }

  // ---------- CPU temperature ----------
  async cpuTemp() {
    return this.cached(
      'cputemp',
      4000,
      async () => {
        const t = await withTimeout(si.cpuTemperature(), 8000);
        const v = t?.main ?? t?.max ?? null;
        return typeof v === 'number' && v > 0 ? v : null;
      },
      { swr: true }
    );
  }
}

// ---------- LibreHardwareMonitor parsing (exported for testing) ----------
// LHM's Remote Web Server exposes a tree at /data.json. Hardware nodes carry
// an ImageURL such as images_icon/cpu.png, sensors are leaves with "xx.x °C".
export function findLhmTemp(root, kind = 'cpu') {
  const isHw =
    kind === 'gpu' ? /nvidia|ati|amd|gpu|intel_gpu|arc/i : /cpu/i;
  const prefer =
    kind === 'gpu' ? /gpu core|^gpu$|hot ?spot/i : /package|tctl|tdie|cpu total|^cpu$|core max/i;
  const temps = [];
  const walk = (node, inHw) => {
    if (!node || typeof node !== 'object') return;
    const img = String(node.ImageURL || '');
    const hw = inHw || (Array.isArray(node.Children) && node.Children.length && isHw.test(img));
    const val = String(node.Value || '');
    if (hw && /°\s*C/i.test(val) && !(node.Children && node.Children.length)) {
      const n = parseFloat(val.replace(',', '.'));
      if (Number.isFinite(n) && n > 0 && n < 150) temps.push({ name: String(node.Text || ''), n });
    }
    for (const c of node.Children || []) walk(c, hw);
  };
  walk(root, false);
  if (!temps.length) return null;
  const hit = temps.find((t) => prefer.test(t.name));
  return hit ? hit.n : Math.max(...temps.map((t) => t.n));
}

// ---------- formatting helpers ----------
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const dec = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 1;
  return { num: v.toFixed(dec), unit: units[i], text: `${v.toFixed(dec)} ${units[i]}` };
}

// Used / total with a shared unit, e.g. "9.1 / 15.9 GB"
export function formatUsage(used, total) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let t = total;
  while (t >= 1024 && i < units.length - 1) {
    t /= 1024;
    i++;
  }
  const div = Math.pow(1024, i);
  const dec = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
  return `${dec(used / div)} / ${dec(total / div)} ${units[i]}`;
}

// bytes/sec -> {num, unit} in either bytes (KB/s, MB/s) or bits (Kbps, Mbps)
export function formatRate(bytesPerSec, mode = 'bytes') {
  let v = Math.max(0, Number(bytesPerSec) || 0);
  let units;
  let base;
  if (mode === 'bits') {
    v *= 8;
    units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
    base = 1000;
  } else {
    units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    base = 1024;
  }
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  const dec = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return { num: v.toFixed(dec), unit: units[i], value: v };
}

export const PLATFORM = { IS_WIN, IS_MAC };
