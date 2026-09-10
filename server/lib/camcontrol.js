'use strict';

// Pan / tilt / zoom arbitration for the table cameras.
//
// Each table has a motorised USB camera (an OBSBOT Tiny 4K, or any UVC camera
// with PTZ controls) opened by that table's own browser, so only that table can
// physically move it. But three parties want to steer it: the team at the
// table, the team next door, and the game master. Every steering input comes
// through here — the owning team's own buttons included — and this forwards a
// single stream of commands to the table holding the camera. One arbiter means
// two pads can never fight over the motor, and no table has to referee.
//
// Priority, highest first:
//   gm        the operator dashboard. Always wins, and can lock the others out.
//   owner     the team whose camera it is.
//   opponent  the team next door.
//
// Whoever steers keeps the camera for HOLD_MS after their last input. That
// grace is what gives priority its teeth: without it the other team could slip
// a command in between two of the owner's taps and the camera would jitter
// between them. A higher rank takes over at once; a lower one waits for the
// grace to run out.
//
// Commands are velocities, not positions, and the table stops the motor by
// itself when it stops hearing them (table/lib/camctl.js). So nothing here has
// to guarantee that a "stop" is ever delivered.

const log = require('./log').scoped('camctl');

const RANK = { opponent: 1, owner: 2, gm: 3 };
const LOCKS = ['open', 'owner', 'gm'];
const HOLD_MS = 2000;
const ZERO = { pan: 0, tilt: 0, zoom: 0 };

const clamp = (value, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
};

// The table's own account of its camera (see diagnose() in table/lib/camctl.js).
// Only known fields, trimmed — it ends up in the event log and on the dashboard.
function cleanDiag(diag) {
  if (!diag || typeof diag !== 'object') return null;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  return {
    label: text(diag.label, 120),
    browser: text(diag.browser, 40),
    browserPtz: !!diag.browserPtz,
    ptzPermission: text(diag.ptzPermission, 20),
    reported: Array.isArray(diag.reported) ? diag.reported.slice(0, 3).map(r => String(r).slice(0, 60)) : [],
  };
}

class CamControl {
  constructor(config) {
    this.cams = new Map();
    this.send = () => {};      // (roomKey, event, payload) to that room's table; set by vs-server
    this.onChange = () => {};  // (roomKey) something the pads display changed; set by vs-server

    for (const [key, room] of Object.entries(config.rooms)) {
      const camera = room.camera || {};
      const ptz = camera.ptz || {};
      const home = ptz.home || {};
      const opp = room.opponent ? config.rooms[room.opponent] : null;
      this.cams.set(key, {
        key,
        name: room.name,
        opponent: room.opponent,
        opponentName: opp ? opp.name : null,
        enabled: camera.enabled !== false && ptz.enabled !== false,
        lock: LOCKS.includes(ptz.lock) ? ptz.lock : 'open',
        home: {
          pan: clamp(home.pan, -1, 1),
          tilt: clamp(home.tilt, -1, 1),
          zoom: clamp(home.zoom, 0, 1),
        },
        flipPan: ptz.invertPan ? -1 : 1,
        flipTilt: ptz.invertTilt ? -1 : 1,
        caps: null,          // { pan, tilt, zoom } booleans, reported by the owning table
        diag: null,          // why caps are what they are, from the owning table
        link: null,          // this room's table: is it receiving the other room's video?
        holder: null,        // 'gm' | 'owner' | 'opponent'
        holderUntil: 0,
      });
    }

    // Expire holds, so the pads stop saying "THEY'RE STEERING" once the other
    // side has let go.
    this.sweeper = setInterval(() => this.sweep(), 250);
  }

  // The part a table plays for a given camera: its own, its opponent's, or
  // neither (a third room, should anyone ever configure one).
  roleOf(camKey, tableKey) {
    const cam = this.cams.get(camKey);
    if (!cam) return null;
    if (camKey === tableKey) return 'owner';
    if (cam.opponent === tableKey) return 'opponent';
    return null;
  }

  holderOf(cam) {
    return cam.holder && Date.now() < cam.holderUntil ? cam.holder : null;
  }

  // null if `who` may steer this camera right now, else the reason not —
  // worded for whoever is asking, because it goes straight onto their screen.
  refusal(cam, who) {
    if (!cam.enabled) return 'Camera steering is turned off for this room.';
    if (!cam.caps) return 'That camera is offline.';
    if (!cam.caps.pan && !cam.caps.tilt && !cam.caps.zoom) return 'That camera can\'t be steered.';
    if (who !== 'gm' && cam.lock === 'gm') return 'The game master has locked this camera.';
    if (who === 'opponent' && cam.lock === 'owner') return 'The game master has locked you out of their camera.';
    const holder = this.holderOf(cam);
    if (holder && RANK[holder] > RANK[who]) {
      return holder === 'gm'
        ? 'The game master is steering this camera.'
        : 'They\'re steering their own camera — they get first say.';
    }
    return null;
  }

  claim(cam, who) {
    const changed = this.holderOf(cam) !== who;
    cam.holder = who;
    cam.holderUntil = Date.now() + HOLD_MS;
    if (changed) {
      log.info(`Room ${cam.key} camera now steered by ${who}`);
      this.onChange(cam.key);
    }
  }

  drive(camKey, who, vector) {
    const cam = this.cams.get(camKey);
    if (!cam || !RANK[who]) return { ok: false, error: 'unknown camera' };
    const v = vector || {};
    const velocity = {
      pan: clamp(v.pan, -1, 1) * cam.flipPan,
      tilt: clamp(v.tilt, -1, 1) * cam.flipTilt,
      zoom: clamp(v.zoom, -1, 1),
    };
    const moving = velocity.pan || velocity.tilt || velocity.zoom;
    // A release from someone who isn't steering has nothing to stop — and
    // refusing it would pop a second "you can't" at a player who already let go.
    if (!moving && this.holderOf(cam) !== who) return { ok: true };

    const why = this.refusal(cam, who);
    if (why) return { ok: false, error: why };
    this.claim(cam, who);
    this.send(camKey, 'cam:drive', { vector: velocity, by: who });
    return { ok: true };
  }

  home(camKey, who) {
    const cam = this.cams.get(camKey);
    if (!cam || !RANK[who]) return { ok: false, error: 'unknown camera' };
    const why = this.refusal(cam, who);
    if (why) return { ok: false, error: why };
    this.claim(cam, who);
    this.send(camKey, 'cam:home', {
      position: {
        pan: cam.home.pan * cam.flipPan,
        tilt: cam.home.tilt * cam.flipTilt,
        zoom: cam.home.zoom,
      },
      by: who,
    });
    return { ok: true };
  }

  // GM only (vs-server checks). 'open' = both teams, 'owner' = the room's own
  // team only, 'gm' = nobody but the game master.
  setLock(camKey, lock) {
    const cam = this.cams.get(camKey);
    if (!cam) return { ok: false, error: 'unknown camera' };
    if (!LOCKS.includes(lock)) return { ok: false, error: `lock must be one of ${LOCKS.join(', ')}` };
    cam.lock = lock;

    // Locking someone out has to take the camera off them now, not whenever
    // they next let go — so stop the motor if they are the one driving it.
    const holder = this.holderOf(cam);
    if (holder && this.refusal(cam, holder)) {
      cam.holder = null;
      cam.holderUntil = 0;
      this.send(camKey, 'cam:drive', { vector: ZERO, by: 'gm' });
    }
    log.info(`Room ${camKey} camera lock set to "${lock}"`);
    this.onChange(camKey);
    return { ok: true };
  }

  // The owning table reports what its camera can do once it has opened it,
  // and again on every reconnect. null means the table has gone.
  setCaps(camKey, caps, diag) {
    const cam = this.cams.get(camKey);
    if (!cam) return;
    const next = caps ? { pan: !!caps.pan, tilt: !!caps.tilt, zoom: !!caps.zoom } : null;
    const nextDiag = next ? cleanDiag(diag) : null;
    if (JSON.stringify([next, nextDiag]) === JSON.stringify([cam.caps, cam.diag])) return;
    cam.caps = next;
    cam.diag = nextDiag;
    if (!next) {
      cam.holder = null;
      cam.holderUntil = 0;
      cam.link = null;
    }
    const axes = next ? Object.keys(next).filter(a => next[a]) : [];
    if (!next) log.info(`Room ${camKey} camera offline`);
    else if (axes.length) log.info(`Room ${camKey} camera steerable: ${axes.join('/')}`, nextDiag ? { camera: nextDiag.label } : undefined);
    else log.warn(`Room ${camKey} camera has no PTZ controls`, nextDiag || undefined);
    this.onChange(camKey);
  }

  // How this room's table is doing at receiving the OTHER room's video.
  setLink(camKey, status) {
    const cam = this.cams.get(camKey);
    if (!cam) return;
    const next = ['live', 'connecting', 'offline'].includes(status) ? status : null;
    if (next === cam.link) return;
    cam.link = next;
    this.onChange(camKey);
  }

  sweep() {
    const now = Date.now();
    for (const cam of this.cams.values()) {
      if (cam.holder && now >= cam.holderUntil) {
        cam.holder = null;
        this.onChange(cam.key);
      }
    }
  }

  status(camKey) {
    const cam = this.cams.get(camKey);
    if (!cam) return null;
    return {
      key: cam.key,
      name: cam.name,
      opponent: cam.opponent,
      opponentName: cam.opponentName,
      enabled: cam.enabled,
      lock: cam.lock,
      caps: cam.caps,
      diag: cam.diag,
      link: cam.link,
      holder: this.holderOf(cam),
    };
  }

  // What one table's pads need: its own camera and the one next door.
  forTable(tableKey) {
    const cam = this.cams.get(tableKey);
    return {
      own: this.status(tableKey),
      opponent: cam && cam.opponent ? this.status(cam.opponent) : null,
    };
  }

  all() {
    const out = {};
    for (const key of this.cams.keys()) out[key] = this.status(key);
    return out;
  }

  shutdown() {
    clearInterval(this.sweeper);
  }
}

module.exports = { CamControl, HOLD_MS, LOCKS };
