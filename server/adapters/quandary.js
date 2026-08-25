'use strict';

// Bridge to Quandary Control. Quandary Control is NOT modified — this joins as
// an ordinary GM socket client and uses its documented REST API, so it keeps
// working across Quandary upgrades.
//
// What we use it for:
//   * mirroring each room's real countdown onto the VS table
//   * the Speed Trap / Steal sabotages (timer_control -> adjust)
//   * pushing hints and status text into the victim room's player screen
//   * publishing VS state back into Quandary variables so the GM sees it
//
// Note on speed-up: Quandary's TimerService derives `remaining` from wall-clock
// elapsed time, so there is no speed multiplier to set. Subtracting one second
// from the duration once per second makes the visible clock fall at 2x, two
// seconds makes it 3x, and so on. The room's total duration shrinks with it,
// which is exactly what the sabotage is meant to do.

const { io } = require('socket.io-client');
const log = require('../lib/log').scoped('quandary');

class QuandaryBridge {
  constructor(cfg, rooms) {
    this.enabled = !!cfg.enabled;
    this.url = String(cfg.url || '').replace(/\/$/, '');
    this.rooms = rooms;                 // { roomKey: quandaryRoomId }
    this.sockets = new Map();           // roomKey -> socket
    this.timers = new Map();            // roomKey -> { remaining, duration, running }
    this.speedJobs = new Map();         // roomKey -> interval handle
    this.onTimer = () => {};
    this.connected = new Map();
  }

  start() {
    if (!this.enabled) {
      log.info('Quandary bridge disabled in config — timer sabotages will be simulated only.');
      return;
    }
    for (const [roomKey, roomId] of Object.entries(this.rooms)) {
      if (!roomId) {
        log.warn(`Room ${roomKey} has no quandaryRoomId — its timer will not be linked.`);
        continue;
      }
      this.connectRoom(roomKey, roomId);
    }
  }

  connectRoom(roomKey, roomId) {
    const socket = io(this.url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });

    socket.on('connect', () => {
      this.connected.set(roomKey, true);
      log.info(`Connected to Quandary for room ${roomKey}`, { roomId });
      socket.emit('join_room', { roomId, clientType: 'gm' });
    });

    socket.on('disconnect', reason => {
      this.connected.set(roomKey, false);
      log.warn(`Quandary disconnected for room ${roomKey}`, { reason });
    });

    socket.on('connect_error', err => {
      this.connected.set(roomKey, false);
      log.warn(`Quandary connect error for room ${roomKey}`, { error: err.message });
    });

    socket.on('timer_update', state => {
      if (!state) return;
      this.timers.set(roomKey, {
        remaining: state.remaining,
        duration: state.duration,
        running: !!state.running,
      });
      this.onTimer(roomKey, this.timers.get(roomKey));
    });

    socket.on('timer_complete', () => {
      const t = this.timers.get(roomKey) || {};
      this.timers.set(roomKey, Object.assign({}, t, { remaining: 0, running: false }));
      this.onTimer(roomKey, this.timers.get(roomKey), 'complete');
    });

    socket.on('error', msg => log.warn(`Quandary error for room ${roomKey}`, { msg }));

    this.sockets.set(roomKey, socket);
  }

  roomId(roomKey) {
    return this.rooms[roomKey] || null;
  }

  timerState(roomKey) {
    return this.timers.get(roomKey) || null;
  }

  isConnected(roomKey) {
    return !!this.connected.get(roomKey);
  }

  adjust(roomKey, amountSeconds) {
    const socket = this.sockets.get(roomKey);
    const roomId = this.roomId(roomKey);
    if (!socket || !roomId) {
      log.warn(`Cannot adjust timer for room ${roomKey} — not linked to Quandary`);
      return false;
    }
    socket.emit('timer_control', { roomId, action: 'adjust', amount: amountSeconds });
    return true;
  }

  // Run the victim's clock at `multiplier` speed for `seconds` of real time.
  // Returns a canceller so the operator can call it off.
  speedUp(roomKey, multiplier, seconds) {
    this.stopSpeedUp(roomKey);
    const extraPerSecond = Math.max(1, Math.round(multiplier - 1));
    const endsAt = Date.now() + seconds * 1000;

    const handle = setInterval(() => {
      if (Date.now() >= endsAt) return this.stopSpeedUp(roomKey);
      this.adjust(roomKey, -extraPerSecond);
    }, 1000);

    this.speedJobs.set(roomKey, handle);
    log.info(`Speed trap running on room ${roomKey}`, { multiplier, seconds });
    return () => this.stopSpeedUp(roomKey);
  }

  stopSpeedUp(roomKey) {
    const handle = this.speedJobs.get(roomKey);
    if (handle) {
      clearInterval(handle);
      this.speedJobs.delete(roomKey);
      log.info(`Speed trap ended on room ${roomKey}`);
    }
  }

  isSpedUp(roomKey) {
    return this.speedJobs.has(roomKey);
  }

  hint(roomKey, message) {
    const socket = this.sockets.get(roomKey);
    const roomId = this.roomId(roomKey);
    if (!socket || !roomId) return false;
    socket.emit('sendHint', { roomId, message });
    return true;
  }

  // Publish a VS value into the Quandary room so it shows on the GM screen and
  // can drive Quandary's own trigger/action system.
  async setVariable(roomKey, name, value) {
    const roomId = this.roomId(roomKey);
    if (!this.enabled || !roomId) return false;
    const type = typeof value === 'boolean' ? 'boolean'
      : typeof value === 'number' ? 'integer' : 'string';
    try {
      const res = await fetch(`${this.url}/api/v1/rooms/${roomId}/variables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, value }),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch (e) {
      log.warn('Failed to publish variable to Quandary', { roomKey, name, error: e.message });
      return false;
    }
  }

  async listRooms() {
    if (!this.enabled) return [];
    try {
      const res = await fetch(`${this.url}/api/v1/rooms`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      const rows = Array.isArray(data) ? data : (data.data || []);
      return rows.map(r => ({ id: r.id, name: r.name, shortcode: r.shortcode }));
    } catch (e) {
      log.warn('Could not list Quandary rooms', { error: e.message });
      return [];
    }
  }

  stopAll() {
    for (const key of [...this.speedJobs.keys()]) this.stopSpeedUp(key);
  }
}

module.exports = { QuandaryBridge };
