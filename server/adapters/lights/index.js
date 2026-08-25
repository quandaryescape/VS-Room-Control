'use strict';

const kasa = require('./kasa');
const http = require('./http-drivers');
const log = require('../../lib/log').scoped('lights');

function nullDriver(cfg) {
  return {
    name: 'null',
    describe: () => 'no lights configured (dry run)',
    async setPower(on) {
      log.info(`[dry run] lights ${on ? 'ON' : 'OFF'}`);
      return { ok: true, failed: [] };
    },
    probe: async () => ({ ok: true, note: 'null driver' }),
  };
}

const DRIVERS = {
  null: nullDriver,
  none: nullDriver,
  kasa: kasa.create,
  shelly: http.shelly,
  hue: http.hue,
  hass: http.hass,
  webhook: http.webhook,
};

// One controller per room. Owns the room's real-world light state so that
// overlapping sabotages can't leave a room dark after the effect ends.
class LightController {
  constructor(roomKey, cfg) {
    this.roomKey = roomKey;
    const make = DRIVERS[String(cfg.driver || 'null').toLowerCase()];
    if (!make) {
      log.error(`Room ${roomKey}: unknown light driver "${cfg.driver}" — falling back to dry run.`);
      this.driver = nullDriver(cfg);
    } else {
      this.driver = make(cfg);
    }
    this.strobeTimer = null;
    this.strobeStop = null;
    this.busy = false;
    log.info(`Room ${roomKey} lights: ${this.driver.describe()}`);
  }

  async setPower(on, opts) {
    try {
      return await this.driver.setPower(on, opts);
    } catch (e) {
      log.error(`Room ${this.roomKey} setPower failed`, { error: e.message });
      return { ok: false, failed: [{ target: this.roomKey, error: e.message }] };
    }
  }

  // Lights out for `seconds`, then back on no matter what — the returned
  // canceller is what the "all stop" button calls.
  blackout(seconds) {
    this.stopStrobe();
    this.setPower(false);
    const t = setTimeout(() => this.setPower(true), seconds * 1000);
    return () => { clearTimeout(t); this.setPower(true); };
  }

  strobe(seconds, intervalMs) {
    this.stopStrobe();

    if (typeof this.driver.nativeStrobe === 'function') {
      this.strobeStop = this.driver.nativeStrobe(seconds);
      return () => this.stopStrobe();
    }

    // Smart bulbs and relays are slow; anything under ~500ms just produces
    // dropped commands and a stuttering, unreliable-looking effect.
    const period = Math.max(400, Number(intervalMs) || 700);
    let on = false;
    this.strobeTimer = setInterval(() => {
      on = !on;
      this.setPower(on);
    }, period);
    const end = setTimeout(() => this.stopStrobe(), seconds * 1000);
    this.strobeStop = () => { clearTimeout(end); };
    return () => this.stopStrobe();
  }

  stopStrobe() {
    if (this.strobeTimer) { clearInterval(this.strobeTimer); this.strobeTimer = null; }
    if (this.strobeStop) { const s = this.strobeStop; this.strobeStop = null; s(); }
  }

  // Called by "all stop" and at the end of every match.
  restore() {
    this.stopStrobe();
    return this.setPower(true);
  }

  probe() {
    return this.driver.probe ? this.driver.probe() : Promise.resolve({ ok: true });
  }
}

module.exports = { LightController };
