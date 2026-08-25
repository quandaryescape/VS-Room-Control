'use strict';

// The VS engine: match state, per-room phase machine, and sabotage routing.
//
// One instance owns both rooms. Everything that can leave a room in a bad
// state (lights off, walls hijacked, clock accelerated) registers a canceller
// so that ending the match — or hitting ALL STOP — always returns the building
// to normal.

const sabotages = require('./sabotages');
const minigames = require('./minigames');
const { LightController } = require('../adapters/lights');
const { WallPlayer } = require('../adapters/wallplayer');
const log = require('./log').scoped('engine');

class Engine {
  constructor(config, quandary, camRelay) {
    this.config = config;
    this.quandary = quandary;
    this.camRelay = camRelay;
    this.serverUrl = null;      // set by vs-server once it knows its LAN address
    this.rooms = {};
    this.match = { armed: false, startedAt: null, endedAt: null };
    this.emit = () => {};        // set by vs-server: (roomKey|null, event, payload)
    this.history = [];

    for (const [key, cfg] of Object.entries(config.rooms)) {
      this.rooms[key] = {
        key,
        name: cfg.name,
        opponent: cfg.opponent,
        cfg,
        lights: new LightController(key, cfg.lights),
        wall: new WallPlayer(key, cfg.wallPlayer),
        tableConnected: false,
        cooldownUntil: 0,
        lockoutUntil: 0,
        soundboardUntil: 0,
        attempt: null,
        offer: null,
        defuse: null,
        incoming: [],
        recentGames: [],
        sabotagesUsed: 0,
        lastAction: null,
      };
    }

    this.quandary.onTimer = (roomKey) => this.pushRoom(roomKey);
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  // ---------- helpers ----------

  room(key) {
    return this.rooms[key] || null;
  }

  opponentOf(key) {
    const r = this.room(key);
    return r && r.opponent ? this.room(r.opponent) : null;
  }

  rules() {
    return this.config.rules;
  }

  capabilitiesOf(roomKey) {
    const r = this.room(roomKey);
    if (!r) return {};
    return {
      lights: String(r.cfg.lights.driver || 'null').toLowerCase() !== 'null'
        && String(r.cfg.lights.driver).toLowerCase() !== 'none',
      wallplayer: !!r.cfg.wallPlayer.enabled,
      audio: r.tableConnected,
      quandary: this.quandary.enabled && !!this.quandary.roomId(roomKey),
    };
  }

  pickSound(soundId) {
    const list = this.config.sounds || [];
    if (!list.length) return null;
    if (soundId) {
      const found = list.find(s => s.id === soundId);
      if (found) return found;
    }
    return list[Math.floor(Math.random() * list.length)];
  }

  // ---------- phase ----------

  phaseOf(roomKey) {
    const r = this.room(roomKey);
    const now = Date.now();
    if (!r) return 'idle';
    if (r.defuse) return 'defusing';
    if (!this.match.armed && this.rules().armedOnly) return 'idle';
    if (r.lockoutUntil > now) return 'lockout';
    if (r.offer) return 'choose';
    if (r.attempt) return 'playing';
    if (r.cooldownUntil > now) return 'cooldown';
    const max = this.rules().maxSabotagesPerTeam;
    if (max > 0 && r.sabotagesUsed >= max) return 'spent';
    return 'ready';
  }

  snapshot(roomKey) {
    const r = this.room(roomKey);
    if (!r) return null;
    const opp = this.opponentOf(roomKey);
    const now = Date.now();

    return {
      key: r.key,
      name: r.name,
      opponentKey: r.opponent,
      opponentName: opp ? opp.name : '—',
      now,
      matchArmed: this.match.armed,
      phase: this.phaseOf(roomKey),
      cooldownUntil: r.cooldownUntil,
      lockoutUntil: r.lockoutUntil,
      soundboardUntil: r.soundboardUntil,
      sabotagesUsed: r.sabotagesUsed,
      maxSabotages: this.rules().maxSabotagesPerTeam,
      sounds: this.config.sounds || [],
      // Totals the table needs to draw progress bars without guessing.
      durations: {
        cooldown: this.rules().cooldownSeconds,
        lockout: this.rules().lockoutSeconds,
        choose: this.rules().sabotageChoiceSeconds,
        minigame: this.rules().minigameTimeLimitSeconds,
        defuse: r.defuse ? r.defuse.totalSeconds : 0,
      },
      attempt: r.attempt && {
        token: r.attempt.token,
        gameId: r.attempt.gameId,
        gameName: minigames.get(r.attempt.gameId).name,
        blurb: minigames.get(r.attempt.gameId).blurb,
        expiresAt: r.attempt.expiresAt,
      },
      offer: r.offer && {
        token: r.offer.token,
        expiresAt: r.offer.expiresAt,
        sabotages: r.offer.sabotages,
      },
      defuse: r.defuse && {
        token: r.defuse.token,
        gameId: r.defuse.gameId,
        gameName: minigames.get(r.defuse.gameId).name,
        expiresAt: r.defuse.expiresAt,
        multiplier: r.defuse.multiplier,
        penaltySeconds: r.defuse.penaltySeconds,
      },
      incoming: r.incoming.map(e => ({ id: e.id, label: e.label, icon: e.icon, until: e.until })),
      timer: this.quandary.timerState(roomKey),
      timerLinked: this.quandary.isConnected(roomKey),
      spedUp: this.quandary.isSpedUp(roomKey),
      opponentState: opp && {
        name: opp.name,
        phase: this.phaseOf(opp.key),
        lastAction: opp.lastAction,
        tableConnected: opp.tableConnected,
        lockedOut: opp.lockoutUntil > now,
      },
    };
  }

  operatorSnapshot() {
    return {
      match: this.match,
      rules: this.rules(),
      rooms: Object.keys(this.rooms).map(k => {
        const r = this.room(k);
        return Object.assign(this.snapshot(k), {
          tableConnected: r.tableConnected,
          capabilities: this.capabilitiesOf(k),
          wallOnline: r.wall.online,
          wallError: r.wall.lastError,
          lights: r.lights.driver.describe(),
        });
      }),
      history: this.history.slice(-40),
    };
  }

  pushRoom(roomKey) {
    if (!this.room(roomKey)) return;
    this.emit(roomKey, 'state', this.snapshot(roomKey));
    // The opponent's panel shows a live read on the other team, so any change
    // to one room refreshes both.
    const opp = this.opponentOf(roomKey);
    if (opp) this.emit(opp.key, 'state', this.snapshot(opp.key));
    this.emit(null, 'operator', this.operatorSnapshot());
  }

  pushAll() {
    for (const key of Object.keys(this.rooms)) {
      this.emit(key, 'state', this.snapshot(key));
    }
    this.emit(null, 'operator', this.operatorSnapshot());
  }

  record(entry) {
    this.history.push(Object.assign({ t: Date.now() }, entry));
    if (this.history.length > 200) this.history.shift();
  }

  // ---------- match control ----------

  startMatch() {
    this.match = { armed: true, startedAt: Date.now(), endedAt: null };
    for (const r of Object.values(this.rooms)) {
      r.cooldownUntil = 0;
      r.lockoutUntil = 0;
      r.sabotagesUsed = 0;
      r.recentGames = [];
      r.lastAction = null;
    }
    log.info('Match armed');
    this.record({ type: 'match', msg: 'Match armed' });
    this.publishToQuandary();
    this.pushAll();
  }

  endMatch() {
    this.match.armed = false;
    this.match.endedAt = Date.now();
    this.allStop({ silent: true });
    log.info('Match ended');
    this.record({ type: 'match', msg: 'Match ended' });
    this.pushAll();
  }

  // Cancel every running effect and put the building back to normal.
  allStop(opts = {}) {
    for (const r of Object.values(this.rooms)) {
      for (const e of r.incoming) {
        try { e.cancel(); } catch (err) { log.warn('cancel failed', { effect: e.id, error: err.message }); }
      }
      r.incoming = [];
      r.soundboardUntil = 0;
      r.lockoutUntil = 0;
      if (r.defuse) {
        clearTimeout(r.defuse.timeout);
        r.defuse = null;
      }
      r.lights.restore();
      r.wall.restore();
      this.emit(r.key, 'cam:stop', {});
      if (this.camRelay) this.camRelay.close(r.key);
      this.quandary.stopSpeedUp(r.key);
    }
    if (!opts.silent) {
      log.info('ALL STOP — every effect cancelled');
      this.record({ type: 'operator', msg: 'ALL STOP' });
    }
    this.pushAll();
  }

  // ---------- mini-game flow ----------

  requestGame(roomKey) {
    const r = this.room(roomKey);
    if (!r) return { ok: false, error: 'unknown room' };

    const phase = this.phaseOf(roomKey);
    if (phase !== 'ready') return { ok: false, error: `not available right now (${phase})` };

    const gameId = minigames.pick(this.rules().minigames, r.recentGames, this.rules().avoidRepeatCount);
    if (!gameId) return { ok: false, error: 'no mini-games are enabled' };

    const game = minigames.get(gameId);
    const limit = this.rules().minigameTimeLimitSeconds || game.timeLimit;

    r.attempt = {
      token: minigames.newToken(),
      gameId,
      startedAt: Date.now(),
      expiresAt: Date.now() + limit * 1000,
    };
    r.recentGames.push(gameId);
    if (r.recentGames.length > 8) r.recentGames.shift();

    log.info(`Room ${roomKey} drew ${gameId}`);
    this.record({ type: 'game', room: roomKey, msg: `drew ${game.name}` });
    this.pushRoom(roomKey);
    return { ok: true, attempt: this.snapshot(roomKey).attempt };
  }

  abandonGame(roomKey, token) {
    const r = this.room(roomKey);
    if (!r || !r.attempt || r.attempt.token !== token) return { ok: false };
    r.attempt = null;
    this.pushRoom(roomKey);
    return { ok: true };
  }

  gameResult(roomKey, token, won) {
    const r = this.room(roomKey);
    if (!r || !r.attempt || r.attempt.token !== token) {
      return { ok: false, error: 'that round has already ended' };
    }
    const gameId = r.attempt.gameId;
    r.attempt = null;

    if (!won) {
      // Losing costs a short breather, not the full sabotage cooldown.
      r.cooldownUntil = Date.now() + Math.min(20, this.rules().cooldownSeconds) * 1000;
      this.record({ type: 'game', room: roomKey, msg: `lost ${gameId}` });
      this.pushRoom(roomKey);
      return { ok: true, won: false };
    }

    const victimKey = r.opponent;
    const caps = this.capabilitiesOf(victimKey);
    const offered = sabotages.availableFor(this.config, caps);
    if (!offered.length) {
      this.record({ type: 'game', room: roomKey, msg: 'won, but no sabotages are available' });
      this.pushRoom(roomKey);
      return { ok: false, error: 'no sabotages are available against that room' };
    }

    r.offer = {
      token: minigames.newToken(),
      sabotages: offered,
      expiresAt: Date.now() + (this.rules().sabotageChoiceSeconds || 45) * 1000,
    };
    log.info(`Room ${roomKey} won ${gameId} — sabotage unlocked`);
    this.record({ type: 'game', room: roomKey, msg: `won ${gameId} — sabotage unlocked` });
    this.pushRoom(roomKey);
    return { ok: true, won: true, offer: this.snapshot(roomKey).offer };
  }

  // Hand a team a sabotage pick without making them play for it — used by the
  // /api/hook/grant webhook so a physical puzzle can award one directly.
  grantSabotage(roomKey) {
    const r = this.room(roomKey);
    if (!r) return { ok: false, error: 'unknown room' };
    if (r.defuse) return { ok: false, error: 'that room is mid-defuse' };

    const offered = sabotages.availableFor(this.config, this.capabilitiesOf(r.opponent));
    if (!offered.length) return { ok: false, error: 'no sabotages are available against that room' };

    r.attempt = null;
    r.cooldownUntil = 0;
    r.offer = {
      token: minigames.newToken(),
      sabotages: offered,
      expiresAt: Date.now() + (this.rules().sabotageChoiceSeconds || 45) * 1000,
    };
    log.info(`Room ${roomKey} was granted a sabotage`);
    this.record({ type: 'grant', room: roomKey, msg: 'granted a sabotage pick' });
    this.pushRoom(roomKey);
    return { ok: true, offer: this.snapshot(roomKey).offer };
  }

  // ---------- sabotage ----------

  chooseSabotage(roomKey, token, sabotageId) {
    const attacker = this.room(roomKey);
    if (!attacker || !attacker.offer || attacker.offer.token !== token) {
      return { ok: false, error: 'that sabotage window has closed' };
    }
    if (!attacker.offer.sabotages.some(s => s.id === sabotageId)) {
      return { ok: false, error: 'that sabotage was not offered' };
    }
    const victim = this.opponentOf(roomKey);
    if (!victim) return { ok: false, error: 'no opponent room configured' };

    attacker.offer = null;
    attacker.sabotagesUsed++;
    attacker.cooldownUntil = Date.now() + (this.rules().cooldownSeconds || 120) * 1000;

    const result = this.fire(roomKey, victim.key, sabotageId);
    this.pushRoom(roomKey);
    return result;
  }

  // Shared by the table flow and the operator's manual buttons.
  fire(attackerKey, victimKey, sabotageId, overrides) {
    const victim = this.room(victimKey);
    if (!victim) return { ok: false, error: 'unknown target room' };
    const def = sabotages.get(sabotageId);
    if (!def) return { ok: false, error: `unknown sabotage "${sabotageId}"` };

    // An operator-fired sabotage names no attacker, so it acts as though the
    // opposing room sent it: identical mechanics and on-screen attribution,
    // and sabotages that hand something back to the attacker (the soundboard
    // window) still have a room to hand it to. The event log keeps the truth.
    const byOperator = !this.room(attackerKey);
    const attacker = this.room(attackerKey) || this.opponentOf(victimKey);
    if (!attacker) return { ok: false, error: 'no attacking room available' };

    const params = Object.assign(sabotages.paramsFor(sabotageId, this.config), overrides || {});
    const label = sabotages.labelFor(sabotageId, this.config);

    let descriptor;
    try {
      descriptor = sabotages.run(sabotageId, {
        engine: this,
        params,
        attackerRoom: attacker,
        victimRoom: victim,
        victim: { lights: victim.lights, wall: victim.wall },
        pickSound: id => this.pickSound(id),
        toVictimTable: (event, payload) => this.emit(victimKey, event, payload),
        toAttackerTable: (event, payload) => this.emit(attacker.key, event, payload),
      });
    } catch (e) {
      log.error(`Sabotage ${sabotageId} threw`, { error: e.message });
      return { ok: false, error: e.message };
    }

    const seconds = descriptor.seconds || 0;
    const effect = {
      id: sabotageId,
      label: descriptor.label ? `${label} — ${descriptor.label}` : label,
      icon: def.icon,
      from: attacker.name,
      until: seconds ? Date.now() + seconds * 1000 : Date.now() + 4000,
      cancel: descriptor.cancel || (() => {}),
    };
    victim.incoming.push(effect);

    attacker.lastAction = { id: sabotageId, label, at: Date.now() };

    // Tell both tables so the attacker gets their gloat screen and the victim
    // gets a warning banner before the lights actually go out.
    this.emit(victimKey, 'incoming', { id: sabotageId, label, icon: def.icon, from: attacker.name, seconds });
    this.emit(attacker.key, 'fired', { id: sabotageId, label, icon: def.icon, target: victim.name, seconds });

    this.quandary.hint(victimKey, `⚠ ${attacker.name} hit you with: ${label}`);

    log.info(`${byOperator ? '[operator] ' : ''}${attacker.name} -> ${victim.name}: ${label}`, { seconds });
    this.record({
      type: 'sabotage',
      room: attacker.key,
      target: victimKey,
      operator: byOperator,
      msg: `${label} (${seconds}s)${byOperator ? ' — fired by the GM' : ''}`,
    });

    this.publishToQuandary();
    this.pushRoom(victimKey);
    return { ok: true, sabotage: sabotageId, seconds };
  }

  fireSound(roomKey, soundId) {
    const r = this.room(roomKey);
    if (!r) return { ok: false, error: 'unknown room' };
    if (r.soundboardUntil <= Date.now()) return { ok: false, error: 'your soundboard window has closed' };
    const victim = this.opponentOf(roomKey);
    if (!victim) return { ok: false, error: 'no opponent room' };
    const sound = this.pickSound(soundId);
    if (!sound) return { ok: false, error: 'no sounds configured' };
    this.emit(victim.key, 'play_sound', { sound, volume: 1 });
    this.record({ type: 'sound', room: roomKey, target: victim.key, msg: sound.label });
    return { ok: true };
  }

  // ---------- wall takeover (live camera) ----------

  // Put one room's camera onto the other room's four walls.
  //
  // The frames have to come from a table's browser, so this asks that table to
  // start pushing, waits for a real frame to land, and only then points mpv at
  // the stream — pointing the walls at an empty stream would just show black.
  // If no frame arrives (camera blocked, table asleep), it quietly falls back
  // to a takeover clip or the glitch effect, so the sabotage always does
  // *something* visible.
  startCamTakeover(sourceKey, victimKey, seconds, fallback) {
    const source = this.room(sourceKey);
    const victim = this.room(victimKey);
    let finished = false;
    let poll = null;

    const stop = () => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(endTimer);
      this.emit(sourceKey, 'cam:stop', {});
      if (this.camRelay) this.camRelay.close(sourceKey);
      victim.wall.restore();
    };

    const endTimer = setTimeout(stop, (seconds + 1) * 1000);

    if (!this.camRelay || !this.serverUrl || !source || !source.tableConnected) {
      clearTimeout(endTimer);
      finished = true;
      fallback();
      return { seconds, cancel() {} };
    }

    // Open the feed before asking for frames, or the first ones are refused.
    this.camRelay.open(sourceKey);
    this.emit(sourceKey, 'cam:push', { fps: 12, width: 960, quality: 0.6 });
    log.info(`Camera takeover: ${source.name} -> ${victim.name} walls`, { seconds });

    const startedAt = Date.now();
    poll = setInterval(() => {
      if (finished) return clearInterval(poll);

      if (this.camRelay.hasLiveFrame(sourceKey)) {
        clearInterval(poll);
        const url = `${this.serverUrl}/api/camstream/${encodeURIComponent(sourceKey)}.mjpg`;
        victim.wall.playStream(url, seconds);
        victim.wall.message(`${source.name.toUpperCase()} IS WATCHING`, 4);
        this.record({ type: 'takeover', room: sourceKey, target: victimKey, msg: 'live camera on all walls' });
        return;
      }

      if (Date.now() - startedAt > 3000) {
        clearInterval(poll);
        log.warn(`No camera frames from room ${sourceKey} — falling back`);
        this.emit(sourceKey, 'cam:stop', {});
        this.camRelay.close(sourceKey);
        fallback();
      }
    }, 150);

    return { seconds, cancel: stop };
  }

  // ---------- speed trap ----------

  startSpeedTrap(victimKey, opts) {
    const victim = this.room(victimKey);
    if (!victim) return { seconds: 0, cancel() {} };

    // Being trapped interrupts whatever the victim was doing on their table.
    victim.attempt = null;
    victim.offer = null;
    if (victim.defuse) clearTimeout(victim.defuse.timeout);

    const gameId = minigames.pickDefuse(this.rules().minigames);
    const defuse = {
      token: minigames.newToken(),
      gameId,
      expiresAt: Date.now() + opts.defuseSeconds * 1000,
      totalSeconds: opts.defuseSeconds,
      multiplier: opts.multiplier,
      penaltySeconds: opts.penaltySeconds,
      timeout: null,
    };
    defuse.timeout = setTimeout(() => this.failDefuse(victimKey), opts.defuseSeconds * 1000);
    victim.defuse = defuse;

    victim.wall.message('DEFUSE IT', Math.min(opts.defuseSeconds, 6));
    this.pushRoom(victimKey);

    return {
      seconds: opts.defuseSeconds + opts.penaltySeconds,
      cancel: () => {
        if (victim.defuse) { clearTimeout(victim.defuse.timeout); victim.defuse = null; }
        this.quandary.stopSpeedUp(victimKey);
        this.pushRoom(victimKey);
      },
    };
  }

  defuseResult(roomKey, token, success) {
    const r = this.room(roomKey);
    if (!r || !r.defuse || r.defuse.token !== token) return { ok: false, error: 'no active speed trap' };
    if (!success) return this.failDefuse(roomKey);

    clearTimeout(r.defuse.timeout);
    r.defuse = null;
    r.wall.message('DEFUSED', 4);
    this.emit(roomKey, 'defused', { ok: true });
    const opp = this.opponentOf(roomKey);
    if (opp) this.emit(opp.key, 'toast', { text: `${r.name} defused your Speed Trap.`, tone: 'bad' });
    this.record({ type: 'defuse', room: roomKey, msg: 'defused the speed trap' });
    log.info(`Room ${roomKey} defused the speed trap`);
    this.pushRoom(roomKey);
    return { ok: true, defused: true };
  }

  failDefuse(roomKey) {
    const r = this.room(roomKey);
    if (!r || !r.defuse) return { ok: false };
    const { multiplier, penaltySeconds } = r.defuse;
    clearTimeout(r.defuse.timeout);
    r.defuse = null;

    this.quandary.speedUp(roomKey, multiplier, penaltySeconds);
    r.wall.message(`CLOCK x${multiplier}`, 5);
    this.emit(roomKey, 'defused', { ok: false, multiplier, penaltySeconds });
    const opp = this.opponentOf(roomKey);
    if (opp) this.emit(opp.key, 'toast', { text: `${r.name} failed to defuse — their clock is at ${multiplier}x.`, tone: 'good' });
    this.record({ type: 'defuse', room: roomKey, msg: `failed — clock at ${multiplier}x for ${penaltySeconds}s` });
    log.info(`Room ${roomKey} failed the defuse — clock at ${multiplier}x`);
    this.pushRoom(roomKey);
    return { ok: true, defused: false };
  }

  // ---------- housekeeping ----------

  tick() {
    const now = Date.now();
    let dirty = false;

    for (const r of Object.values(this.rooms)) {
      if (r.attempt && r.attempt.expiresAt <= now) {
        r.attempt = null;
        r.cooldownUntil = now + Math.min(20, this.rules().cooldownSeconds) * 1000;
        this.emit(r.key, 'toast', { text: 'Out of time.', tone: 'bad' });
        dirty = true;
      }
      if (r.offer && r.offer.expiresAt <= now) {
        // Letting the window lapse still burns the earned sabotage, otherwise
        // a team could sit on one indefinitely and stall the match.
        r.offer = null;
        r.cooldownUntil = now + Math.min(30, this.rules().cooldownSeconds) * 1000;
        this.emit(r.key, 'toast', { text: 'You took too long to choose.', tone: 'bad' });
        dirty = true;
      }
      const before = r.incoming.length;
      r.incoming = r.incoming.filter(e => e.until > now);
      if (r.incoming.length !== before) dirty = true;
      if (r.soundboardUntil && r.soundboardUntil <= now) { r.soundboardUntil = 0; dirty = true; }
      if (r.lockoutUntil && r.lockoutUntil <= now) { r.lockoutUntil = 0; dirty = true; }
      if (r.cooldownUntil && r.cooldownUntil <= now) { r.cooldownUntil = 0; dirty = true; }
    }

    if (dirty) this.pushAll();
  }

  // Mirror the headline VS numbers into Quandary variables so they appear on
  // the GM screen and can drive Quandary's own triggers.
  publishToQuandary() {
    for (const r of Object.values(this.rooms)) {
      this.quandary.setVariable(r.key, 'vs_sabotages_used', r.sabotagesUsed);
      this.quandary.setVariable(r.key, 'vs_locked_out', r.lockoutUntil > Date.now());
    }
  }

  setTableConnected(roomKey, connected) {
    const r = this.room(roomKey);
    if (!r) return;
    r.tableConnected = connected;
    log.info(`Room ${roomKey} table ${connected ? 'connected' : 'disconnected'}`);
    this.pushRoom(roomKey);
  }

  shutdown() {
    clearInterval(this.ticker);
    this.allStop({ silent: true });
  }
}

module.exports = { Engine };
