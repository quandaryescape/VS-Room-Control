'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./log').scoped('config');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

const DEFAULTS = {
  port: 8990,
  operatorPin: '',
  quandary: { enabled: false, url: 'http://127.0.0.1:3000' },
  rules: {
    cooldownSeconds: 120,
    lockoutSeconds: 300,
    minigameTimeLimitSeconds: 90,
    sabotageChoiceSeconds: 45,
    armedOnly: true,
    maxSabotagesPerTeam: 0,
    minigames: ['flappy', 'simon', 'runner', 'flow', 'reaction', 'memory'],
    avoidRepeatCount: 2,
  },
  rooms: {},
  sabotages: {},
  sounds: [],
};

// Strip the "//"-prefixed documentation keys so they never reach game logic.
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '//' || k.startsWith('//')) continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return value;
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let config = null;

function load() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else if (fs.existsSync(EXAMPLE_PATH)) {
    log.warn('config.json not found — running from config.example.json. Copy it to config.json and edit.');
    raw = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  } else {
    log.warn('No config found — using built-in defaults with no rooms.');
  }

  config = deepMerge(DEFAULTS, stripComments(raw));
  delete config.lightDriverExamples;

  // Normalise room keys and make sure opponents point at each other.
  for (const [key, room] of Object.entries(config.rooms)) {
    room.key = key;
    room.name = room.name || `Room ${key}`;
    if (!room.opponent) {
      const others = Object.keys(config.rooms).filter(k => k !== key);
      room.opponent = others[0] || null;
    }
    room.wallPlayer = room.wallPlayer || { enabled: false };
    room.lights = room.lights || { driver: 'null', devices: [], options: {} };
    room.camera = room.camera || { enabled: false };
  }

  const bad = Object.values(config.rooms).filter(r => r.opponent && !config.rooms[r.opponent]);
  for (const r of bad) {
    log.error(`Room "${r.key}" points at opponent "${r.opponent}", which is not configured.`);
    r.opponent = null;
  }

  return config;
}

function get() {
  if (!config) load();
  return config;
}

function roomKeys() {
  return Object.keys(get().rooms);
}

function room(key) {
  return get().rooms[key] || null;
}

function opponentOf(key) {
  const r = room(key);
  return r && r.opponent ? room(r.opponent) : null;
}

// Write-back is only used by the operator dashboard (arming rules, toggling
// sabotages). Hardware addresses are edited by hand in config.json.
function save() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  log.info('config.json written');
}

// Apply a patch to the sections the settings screen is allowed to touch, then
// write it back.
//
// This deliberately re-reads config.json from disk and edits THAT, rather than
// serialising the in-memory config. The in-memory copy has been merged with
// DEFAULTS, had every "//" documentation key stripped out, and had rooms
// normalised with derived fields. Writing it back would silently delete the
// operator's own comments - the notes saying which light is which - and bake
// defaults in as though they had been chosen. The file people hand-edit stays
// the file people hand-edit; only the keys actually set here change.
function savePatch(patch) {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else if (fs.existsSync(EXAMPLE_PATH)) {
    // First save on a box that never had a config.json: seed from the example
    // so the result keeps its documentation rather than being a bare stub.
    raw = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  }

  for (const section of ['rules', 'sabotages']) {
    if (!patch[section]) continue;
    raw[section] = raw[section] || {};
    for (const [key, value] of Object.entries(patch[section])) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        raw[section][key] = Object.assign({}, raw[section][key], value);
      } else {
        raw[section][key] = value;
      }
    }
  }

  // Write to a temp file and rename, so a crash mid-write cannot leave the
  // room with a truncated config.json that will not parse on next boot.
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);

  // Mutate the live config in place rather than reassigning it. The engine and
  // the adapters captured this object at startup; handing them a new one would
  // leave them reading the old settings until a restart, which is the restart
  // this screen exists to avoid.
  const merged = deepMerge(DEFAULTS, stripComments(raw));
  for (const section of ['rules', 'sabotages']) {
    if (!patch[section]) continue;
    config[section] = config[section] || {};
    for (const key of Object.keys(merged[section] || {})) {
      config[section][key] = merged[section][key];
    }
  }

  log.info('config.json updated from the settings screen');
  return config;
}

module.exports = { load, get, save, savePatch, room, roomKeys, opponentOf, ROOT, CONFIG_PATH };
