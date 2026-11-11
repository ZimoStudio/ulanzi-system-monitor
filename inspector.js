// Property Inspector for all System Monitor actions.
// The action type is read from the action UUID (…systemmonitor.<type>).

const DEFAULTS = {
  cpu: { warn: 70, crit: 90 },
  mem: { warn: 70, crit: 90 },
  disk: { warn: 80, crit: 95 },
  net: { warn: 70, crit: 90 },
  gpu: { warn: 70, crit: 90 },
  temp: { warn: 70, crit: 85 },
  overview: { warn: 70, crit: 90 },
  ping: { warn: 80, crit: 150 },
  battery: { warn: 30, crit: 15 },
  cores: { warn: 70, crit: 90 },
  dashboard: { warn: 70, crit: 90 },
};

let form = null;

// Fallback UUID is only used when the host does not pass ?uuid= in the URL.
$UD.connect('com.ulanzi.ulanzistudio.systemmonitor.cpu');

function actionType() {
  return String($UD.uuid || '').split('.').pop();
}

function applyVisibility() {
  const type = actionType();
  document.querySelectorAll('[data-for]').forEach((el) => {
    const list = el.getAttribute('data-for').split(/\s+/);
    el.classList.toggle('hidden', !list.includes(type));
  });
  const d = DEFAULTS[type] || DEFAULTS.cpu;
  document.getElementById('warn').placeholder = `default ${d.warn}`;
  document.getElementById('crit').placeholder = `default ${d.crit}`;
}

function loadSettings(param) {
  if (param && typeof param === 'object' && Object.keys(param).length) {
    Utils.setFormValue(param, form);
  }
}

function save() {
  $UD.sendParamFromPlugin(Utils.getFormValue(form));
}

$UD.onConnected(() => {
  form = document.querySelector('#property-inspector');
  applyVisibility();
  // Uptime opens the dashboard by default (matches the main service)
  if (actionType() === 'uptime' && form.elements.press) form.elements.press.value = 'dashboard';
  document.getElementById('wrapper').classList.remove('hidden');

  const debounced = Utils.debounce(save, 250);
  form.addEventListener('input', debounced);
  form.addEventListener('change', debounced);
  form.addEventListener('submit', (e) => e.preventDefault());
});

// Saved settings arrive on either event; listen to both so none are missed.
$UD.onAdd((jsn) => loadSettings(jsn?.param));
$UD.onParamFromApp((jsn) => loadSettings(jsn?.param));
