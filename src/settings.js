// Player settings that tune the shooter, saved in this browser.

const KEY = '201sim.settings.v1';

export const SETTING_DEFS = {
  hubPower: {
    label: 'HUB shot power', unit: '%', min: 80, max: 120, step: 1, def: 100,
    help: '100% lands auto shots in the HUB. Raise or lower it to match how the real shooter behaves.',
  },
  passPower: {
    label: 'Pass power boost', unit: '%', min: 100, max: 200, step: 5, def: 140,
    help: 'How much harder the shooter spins when passing, so you can reach your alliance zone from across the field. 100% means no boost.',
  },
  fireRate: {
    label: 'Fire rate', unit: ' FUEL/s', min: 2, max: 15, step: 0.5, def: 8,
    help: 'How fast the spindexer feeds FUEL into the shooter.',
  },
  capacity: {
    label: 'Hopper capacity', unit: ' FUEL', min: 10, max: 80, step: 1, def: 40,
    help: 'How many FUEL the robot can hold.',
  },
  showTrajectory: {
    label: 'Show aim line', type: 'bool', def: true,
    help: 'Draw where an auto shot or pass will go while you hold the button.',
  },
};

export function loadSettings() {
  const s = {};
  for (const [k, d] of Object.entries(SETTING_DEFS)) s[k] = d.def;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) for (const k of Object.keys(s)) if (saved[k] !== undefined) s[k] = saved[k];
  } catch { /* defaults */ }
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* not saved */ }
}

/** Fill the Settings panel and keep `settings` updated as sliders move. */
export function buildSettingsPanel(panel, settings) {
  const list = panel.querySelector('.settings-list');
  const render = () => {
    list.innerHTML = '';
    for (const [k, d] of Object.entries(SETTING_DEFS)) {
      const row = document.createElement('label');
      row.className = 'setting';
      if (d.type === 'bool') {
        row.innerHTML = `<span class="name">${d.label}</span><input type="checkbox" ${settings[k] ? 'checked' : ''}>` +
          `<small>${d.help}</small>`;
        row.querySelector('input').addEventListener('change', (e) => { settings[k] = e.target.checked; saveSettings(settings); });
      } else {
        row.innerHTML = `<span class="name">${d.label}</span><span class="val"></span>` +
          `<input type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${settings[k]}">` +
          `<small>${d.help}</small>`;
        const val = row.querySelector('.val');
        const input = row.querySelector('input');
        const show = () => { val.textContent = `${settings[k]}${d.unit}`; };
        input.addEventListener('input', () => { settings[k] = +input.value; show(); saveSettings(settings); });
        show();
      }
      list.appendChild(row);
    }
  };
  panel.querySelector('.settings-reset').addEventListener('click', () => {
    for (const [k, d] of Object.entries(SETTING_DEFS)) settings[k] = d.def;
    saveSettings(settings);
    render();
  });
  render();
}
