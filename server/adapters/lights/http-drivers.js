'use strict';

// Every light driver that is "just an HTTP call": Shelly, Philips Hue,
// Home Assistant, and a raw configurable webhook.

const log = require('../../lib/log').scoped('lights:http');

const TIMEOUT_MS = 3000;

async function req(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.headers,
    body: opts.body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return text; }
}

async function fanOut(targets, fn, on) {
  const results = await Promise.allSettled(targets.map(fn));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? { target: targets[i], error: r.reason.message } : null))
    .filter(Boolean);
  if (failed.length) log.warn('some lights did not respond', { failed, on });
  return { ok: failed.length < Math.max(targets.length, 1), failed };
}

// ---------- Shelly ----------
// gen 1: /relay/0?turn=on   gen 2+ (Plus/Pro): /rpc/Switch.Set?id=0&on=true
function shelly(cfg) {
  const devices = cfg.devices || [];
  const gen = Number((cfg.options && cfg.options.gen) || 2);
  const channel = Number((cfg.options && cfg.options.channel) || 0);
  return {
    name: 'shelly',
    describe: () => `Shelly gen${gen} (${devices.length})`,
    setPower(on) {
      return fanOut(devices, ip => {
        const url = gen === 1
          ? `http://${ip}/relay/${channel}?turn=${on ? 'on' : 'off'}`
          : `http://${ip}/rpc/Switch.Set?id=${channel}&on=${on ? 'true' : 'false'}`;
        return req(url);
      }, on);
    },
    probe() {
      return fanOut(devices, ip => req(gen === 1 ? `http://${ip}/status` : `http://${ip}/rpc/Shelly.GetStatus`), null);
    },
  };
}

// ---------- Philips Hue ----------
function hue(cfg) {
  const devices = cfg.devices || [];
  const bridge = (cfg.options && cfg.options.bridge) || '';
  const user = (cfg.options && cfg.options.username) || '';
  const base = `http://${bridge}/api/${user}/lights`;
  const put = (id, body) => req(`${base}/${id}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    name: 'hue',
    describe: () => `Hue bridge ${bridge} (${devices.length} lights)`,
    setPower(on, opts) {
      const body = { on, transitiontime: 0 };
      if (on && opts && typeof opts.brightness === 'number') {
        body.bri = Math.max(1, Math.min(254, Math.round(opts.brightness * 2.54)));
      }
      return fanOut(devices, id => put(id, body), on);
    },
    // Hue has a built-in 15-second breathe/flash that looks far better than
    // hammering on/off over the network, so the strobe effect prefers it.
    nativeStrobe(seconds) {
      const stop = () => fanOut(devices, id => put(id, { alert: 'none' }), null);
      fanOut(devices, id => put(id, { alert: 'lselect' }), null);
      const t = setTimeout(stop, Math.min(seconds, 15) * 1000);
      return () => { clearTimeout(t); stop(); };
    },
    probe: () => req(base),
  };
}

// ---------- Home Assistant ----------
function hass(cfg) {
  const devices = cfg.devices || [];
  const url = ((cfg.options && cfg.options.url) || '').replace(/\/$/, '');
  const token = (cfg.options && cfg.options.token) || '';
  const call = (domain, service, entity) => req(`${url}/api/services/${domain}/${service}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_id: entity }),
  });
  return {
    name: 'hass',
    describe: () => `Home Assistant ${url} (${devices.length} entities)`,
    setPower(on) {
      return fanOut(devices, entity => {
        const domain = String(entity).split('.')[0] || 'homeassistant';
        return call(domain, on ? 'turn_on' : 'turn_off', entity);
      }, on);
    },
    probe: () => req(`${url}/api/`, { headers: { Authorization: `Bearer ${token}` } }),
  };
}

// ---------- raw webhook ----------
// Escape hatch for relay boards, Arduino sketches, IFTTT-style endpoints,
// or any controller not covered above.
function webhook(cfg) {
  const o = cfg.options || {};
  return {
    name: 'webhook',
    describe: () => `webhook (${o.on || '?'})`,
    async setPower(on) {
      const url = on ? o.on : o.off;
      if (!url) return { ok: false, failed: [{ target: 'webhook', error: 'no URL configured' }] };
      try {
        await req(url, { method: o.method || 'GET', headers: o.headers, body: on ? o.onBody : o.offBody });
        return { ok: true, failed: [] };
      } catch (e) {
        log.warn('webhook failed', { url, error: e.message });
        return { ok: false, failed: [{ target: url, error: e.message }] };
      }
    },
    probe: async () => ({ on: o.on, off: o.off }),
  };
}

module.exports = { shelly, hue, hass, webhook };
