'use strict';

// Client for the (modified) Wall Player running on each room's projector PC.
// Everything here is fire-and-forget: a projector PC that is off or rebooting
// must never block a sabotage from reaching the lights and speakers.

const log = require('../lib/log').scoped('wallplayer');

const TIMEOUT_MS = 3000;

class WallPlayer {
  constructor(roomKey, cfg) {
    this.roomKey = roomKey;
    this.enabled = !!cfg.enabled;
    this.url = String(cfg.url || '').replace(/\/$/, '');
    this.token = cfg.token || '';
    this.sabotageVideos = cfg.sabotageVideos || [];
    this.online = null;
    this.lastError = null;
  }

  async call(path, body) {
    if (!this.enabled || !this.url) return { ok: false, error: 'wall player disabled' };
    try {
      const res = await fetch(this.url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          this.token ? { 'X-VS-Token': this.token } : {}
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await res.json();
      this.online = true;
      this.lastError = null;
      return data;
    } catch (e) {
      this.online = false;
      this.lastError = e.message;
      log.warn(`Room ${this.roomKey} wall player unreachable`, { url: this.url, error: e.message });
      return { ok: false, error: e.message };
    }
  }

  // effect: blackout | dim | flash | glitch | desaturate | hue | restore
  effect(name, params) {
    return this.call('/api/effect', Object.assign({ effect: name }, params || {}));
  }

  // Big text across all four walls, drawn by mpv's OSD.
  message(text, seconds) {
    return this.call('/api/message', { text, seconds: seconds || 5 });
  }

  // Slam one video onto every wall at once, then fall back to the shuffle.
  playAll(file, seconds) {
    return this.call('/api/playall', { file, seconds });
  }

  // Same, but for a live network stream (the other room's camera). The Wall
  // Player drops its read-ahead buffering for these so the walls stay in step
  // with the room rather than running a minute behind.
  playStream(url, seconds) {
    return this.call('/api/playall', { url, seconds, live: true });
  }

  restore() {
    return this.call('/api/effect', { effect: 'restore' });
  }

  status() {
    return this.call('/api/status');
  }

  randomSabotageVideo() {
    if (!this.sabotageVideos.length) return null;
    return this.sabotageVideos[Math.floor(Math.random() * this.sabotageVideos.length)];
  }
}

module.exports = { WallPlayer };
