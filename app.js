// System Monitor - main service (Node.js)
// Connects to UlanziStudio through the official common-node SDK and keeps
// every key that uses one of our actions updated with live system stats.

import UlanziApi from './plugin-common-node/index.js';
import { Metrics } from './metrics.js';
import { Monitor, TYPES } from './monitor.js';
import { Dashboard } from './dashboard.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.systemmonitor';

// The SDK prints every outgoing message (including the full base64 icon) with
// console.warn. Keep logs small unless debugging: set env SM_DEBUG=1 to see it.
if (process.env.SM_DEBUG !== '1') {
  for (const k of ['log', 'warn']) {
    const orig = console[k].bind(console);
    console[k] = (...args) => {
      const noisy = args.some(
        (a) => typeof a === 'string' && (a.includes('[ULANZIDECK]') || a.startsWith("can't project"))
      );
      if (!noisy) orig(...args);
    };
  }
}

const $UD = new UlanziApi();
const metrics = new Metrics();
const monitors = new Map(); // context -> Monitor
const dashboard = new Dashboard(metrics, (msg) => {
  try {
    $UD.logMessage(msg, 'info');
  } catch (_) {
    /* ignore */
  }
});
dashboard.start().catch((err) => {
  try {
    $UD.logMessage(`Dashboard failed to start: ${err?.message || err}`, 'error');
  } catch (_) {
    /* ignore */
  }
});

function openDashboard() {
  if (dashboard.url) $UD.openUrl(dashboard.url);
  else $UD.toast('Dashboard is not running');
}

// Action UUID "com.ulanzi.ulanzistudio.systemmonitor.cpu" -> "cpu"
function typeFromContext(context) {
  const { uuid } = $UD.decodeContext(context);
  const last = String(uuid || '').split('.').pop();
  return TYPES.includes(last) ? last : null;
}

function ensure(jsn) {
  const context = jsn.context;
  let m = monitors.get(context);
  if (!m) {
    const type = typeFromContext(context);
    if (!type) return null;
    m = new Monitor(context, type, $UD, metrics);
    monitors.set(context, m);
  }
  return m;
}

function applySettings(jsn) {
  const m = ensure(jsn);
  if (!m) return;
  m.update(jsn.param || {});
  m.refresh();
}

$UD.connect(PLUGIN_UUID);

$UD.onConnected(() => {
  $UD.logMessage('System Monitor connected', 'info');
});

// Action dragged onto a key (or restored from a saved profile)
$UD.onAdd((jsn) => applySettings(jsn));

// Saved settings pushed by the host / changed in the Property Inspector
$UD.onParamFromApp((jsn) => applySettings(jsn));
$UD.onParamFromPlugin((jsn) => applySettings(jsn));

// Key pressed: open the dashboard, or toggle ring <-> graph (not saved)
$UD.onRun((jsn) => {
  const m = ensure(jsn);
  if (!m) return;
  if (m.type === 'dashboard' || m.settings.press === 'dashboard') {
    openDashboard();
    return;
  }
  m.toggleStyle();
  m.refresh();
});

// Page switched on the device: pause updates for hidden keys
$UD.onSetActive((jsn) => {
  const m = ensure(jsn);
  if (m) m.setActive(jsn.active);
});

// Action removed from key(s)
$UD.onClear((jsn) => {
  for (const item of jsn.param || []) {
    monitors.delete(item.context);
  }
});

// Single scheduler for all keys
const timer = setInterval(() => {
  const now = Date.now();
  for (const m of monitors.values()) m.tick(now);
}, 500);

function shutdown() {
  clearInterval(timer);
  dashboard.stop();
  setTimeout(() => process.exit(0), 100);
}

// If UlanziStudio goes away, don't leave an orphan Node process running.
$UD.onClose(shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('uncaughtException', (err) => {
  try {
    $UD.logMessage(`uncaughtException: ${err?.stack || err}`, 'error');
  } catch (_) {
    /* ignore */
  }
});
process.on('unhandledRejection', (err) => {
  try {
    $UD.logMessage(`unhandledRejection: ${err?.stack || err}`, 'error');
  } catch (_) {
    /* ignore */
  }
});
