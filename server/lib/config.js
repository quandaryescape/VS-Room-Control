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

module.exports = { load, get, save, room, roomKeys, opponentOf, ROOT, CONFIG_PATH };
