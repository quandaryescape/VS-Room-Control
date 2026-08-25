'use strict';

// TP-Link Kasa (HS/KP plugs, KL bulbs) over the local LAN protocol on TCP 9999.
// No cloud account, no npm package: the wire format is a 4-byte big-endian
// length followed by JSON run through TP-Link's "autokey" XOR cipher.

const net = require('net');
const log = require('../../lib/log').scoped('lights:kasa');

const PORT = 9999;
const TIMEOUT_MS = 2500;

function encrypt(text) {
  const buf = Buffer.from(text, 'utf8');
  const out = Buffer.alloc(buf.length + 4);
  out.writeUInt32BE(buf.length, 0);
  let key = 0xAB;
  for (let i = 0; i < buf.length; i++) {
    key = key ^ buf[i];
    out[i + 4] = key;
  }
  return out;
}

function decrypt(buf) {
  let key = 0xAB;
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = key ^ buf[i];
    key = buf[i];
  }
  return out.toString('utf8');
}

function send(ip, payload) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let chunks = [];
    let expected = null;
    let done = false;

    const finish = (err, data) => {
      if (done) return;
      done = true;
      sock.destroy();
      err ? reject(err) : resolve(data);
    };

    sock.setTimeout(TIMEOUT_MS);
    sock.on('timeout', () => finish(new Error(`${ip} timed out`)));
    sock.on('error', err => finish(err));
    sock.on('data', chunk => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      if (expected === null && all.length >= 4) expected = all.readUInt32BE(0);
      if (expected !== null && all.length >= expected + 4) {
        try {
          finish(null, JSON.parse(decrypt(all.subarray(4, expected + 4))));
        } catch (e) {
          finish(new Error(`${ip} sent an unreadable reply`));
        }
      }
    });
    sock.on('close', () => finish(new Error(`${ip} closed the connection early`)));
    sock.connect(PORT, ip, () => sock.write(encrypt(JSON.stringify(payload))));
  });
}

// Bulbs and plugs speak different command namespaces, so ask once and remember.
const kindCache = new Map();

async function kindOf(ip) {
  if (kindCache.has(ip)) return kindCache.get(ip);
  let kind = 'plug';
  try {
    const info = await send(ip, { system: { get_sysinfo: {} } });
    const sys = info && info.system && info.system.get_sysinfo;
    if (sys) {
      const model = String(sys.model || '');
      const type = String(sys.type || sys.mic_type || '');
      if (/bulb/i.test(type) || /^KL|^LB/i.test(model)) kind = 'bulb';
      if (sys.children && sys.children.length) kind = 'strip';
      kindCache.set(ip, kind);
      log.info(`${ip} identified`, { model, kind });
    }
  } catch (e) {
    log.warn(`${ip} did not answer get_sysinfo — assuming a plug`, { error: e.message });
  }
  kindCache.set(ip, kind);
  return kind;
}

async function setOne(ip, on, brightness) {
  const kind = await kindOf(ip);
  if (kind === 'bulb') {
    const state = { on_off: on ? 1 : 0, transition_period: 0 };
    if (on && typeof brightness === 'number') {
      state.brightness = Math.max(1, Math.min(100, Math.round(brightness)));
      state.ignore_default = 1;
    }
    return send(ip, { 'smartlife.iot.smartbulb.lightingservice': { transition_light_state: state } });
  }
  if (kind === 'strip') {
    // Address every child outlet on a power strip.
    const info = await send(ip, { system: { get_sysinfo: {} } });
    const sys = info.system.get_sysinfo;
    const ids = (sys.children || []).map(c => sys.deviceId + c.id);
    return send(ip, { context: { child_ids: ids }, system: { set_relay_state: { state: on ? 1 : 0 } } });
  }
  return send(ip, { system: { set_relay_state: { state: on ? 1 : 0 } } });
}

function create(cfg) {
  const devices = cfg.devices || [];
  return {
    name: 'kasa',
    describe: () => `Kasa (${devices.length} device${devices.length === 1 ? '' : 's'})`,
    async setPower(on, opts) {
      const results = await Promise.allSettled(
        devices.map(ip => setOne(ip, on, opts && opts.brightness))
      );
      const failed = results
        .map((r, i) => (r.status === 'rejected' ? devices[i] : null))
        .filter(Boolean);
      if (failed.length) log.warn('some devices did not respond', { failed, on });
      return { ok: failed.length < devices.length, failed };
    },
    async probe() {
      const out = {};
      for (const ip of devices) {
        try {
          const info = await send(ip, { system: { get_sysinfo: {} } });
          const sys = info.system.get_sysinfo;
          out[ip] = { ok: true, alias: sys.alias, model: sys.model, kind: await kindOf(ip) };
        } catch (e) {
          out[ip] = { ok: false, error: e.message };
        }
      }
      return out;
    },
  };
}

module.exports = { create };
