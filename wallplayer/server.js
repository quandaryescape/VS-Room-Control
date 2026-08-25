// server.js — Wall Player control server
// Runs on the player PC (the one with the projectors attached).
// Serves a web control panel on the LAN and drives one mpv instance
// per monitor via mpv's JSON IPC (Windows named pipes).
//
// Requires: Node.js (any recent version) and mpv. No npm packages.
//
// Start with StartServer.bat, then open http://<player-pc-ip>:8991
// from any computer on the network.
//
// ---------------------------------------------------------------------------
// VS ROOM ADDITIONS
// ---------------------------------------------------------------------------
// The VS server (see ../server/vs-server.js) drives the projectors as part of
// a sabotage. Everything it needs lives behind three endpoints:
//
//   POST /api/effect   { effect, seconds, ... }  blackout / dim / flash /
//                                                glitch / desaturate / hue /
//                                                restore
//   POST /api/message  { text, seconds }         big OSD text on every wall
//   POST /api/playall  { file, seconds }         slam one clip onto all walls
//
// Effects are applied through mpv's video equalizer rather than by swapping
// files, so they are instant, reversible, and never disturb the shuffle. Each
// one carries its own expiry INSIDE this process: if the VS server crashes
// mid-sabotage, the walls still come back on their own.
//
// Set "vsToken" in config.json to require a matching X-VS-Token header.
// ---------------------------------------------------------------------------

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PORT = 8991;
const HERE = __dirname;
const CONFIG_PATH = path.join(HERE, 'config.json');

// ---------- config ----------
let config = {
  folder: 'C:\\Videos',
  mpvPath: 'mpv', // set full path here if mpv.exe is not on PATH
  muted: true,
  locks: {}, // screen index -> filename pinned to that screen
  vsToken: '', // shared secret with the VS server; blank = no auth
  osdFontSize: 96, // size of sabotage text drawn across the walls
};
try {
  Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch (e) {
  // A missing file is just a first run. A malformed one is not: every setting
  // silently reverts to defaults, which would quietly switch the VS token off
  // and send the players back to C:\Videos. Say so loudly instead.
  // (Windows paths need doubled backslashes in JSON: "C:\\Videos".)
  if (fs.existsSync(CONFIG_PATH)) {
    console.error('');
    console.error('  !! config.json could not be read: ' + e.message);
    console.error('  !! Running on DEFAULTS — folder, locks, mute and vsToken are all ignored.');
    console.error('  !! Windows paths need doubled backslashes, e.g. "C:\\\\Videos".');
    console.error('');
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Append stall/recovery events to stalls.log so problem files can be spotted
function logStall(line) {
  const stamp = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS
  fs.appendFile(path.join(HERE, 'stalls.log'), `${stamp}  ${line}\n`, () => {});
}

// ---------- locate mpv.exe ----------
// Checks config.json first, then common install locations, then PATH.
let MPV_EXE = null;

function findMpv() {
  const { execFileSync } = require('child_process');
  const candidates = [
    config.mpvPath && config.mpvPath !== 'mpv' ? config.mpvPath : null,
    path.join(HERE, 'mpv.exe'),                    // dropped next to server.js
    path.join(HERE, 'mpv', 'mpv.exe'),             // in an "mpv" subfolder
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'mpv.exe'),
    'C:\\Program Files\\mpv\\mpv.exe',
    'C:\\Program Files (x86)\\mpv\\mpv.exe',
    path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'mpv.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\mpv.exe',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Last resort: is it on PATH after all?
  try {
    const out = execFileSync('where', ['mpv'], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find(l => l.trim());
    if (first) return first.trim();
  } catch (e) { /* not on PATH */ }
  return null;
}

// ---------- video folder ----------
const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.wmv',
  '.mpg', '.mpeg', '.ts', '.m2ts', '.flv', '.3gp',
]);

function listVideos() {
  try {
    return fs.readdirSync(config.folder)
      .filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch (e) {
    return null; // folder unreadable
  }
}

// ---------- monitor detection ----------
function getScreenCount() {
  return new Promise(resolve => {
    execFile('powershell', [
      '-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens.Count',
    ], (err, stdout) => {
      const n = parseInt(String(stdout || '').trim(), 10);
      resolve(!err && n > 0 ? n : 1);
    });
  });
}

// ---------- mpv player wrapper ----------
class Player {
  constructor(index) {
    this.index = index;
    this.proc = null;
    this.sock = null;
    this.buf = '';
    this.pending = new Map();
    this.reqId = 1;
    this.nowPlaying = null;
    this.queuedNext = null;
    this.locked = null; // filename pinned to this screen, loops forever
    this.queueing = false;
    this.connectTimer = null;
    this.lastTimePos = null;
    this.stallTicks = 0;
    this.restarting = false;
    this.streaming = false; // showing a live camera feed for a VS takeover
  }

  get pipePath() { return '\\\\.\\pipe\\mpv-wall-' + this.index; }
  get running() { return this.proc !== null; }

  start() {
    if (this.proc) return;
    const args = [
      '--screen=' + this.index,
      '--fs', '--fs-screen=' + this.index,
      '--no-border', '--no-osc', '--no-osd-bar',
      '--cursor-autohide=always',
      '--keep-open=no', '--idle=yes',
      '--prefetch-playlist=yes',
      '--hwdec=auto-safe',
      // Big read-ahead buffer: with several players sharing one disk,
      // each buffers ~60s ahead so momentary I/O contention can't
      // starve the decoder and freeze the picture.
      '--cache=yes',
      '--demuxer-max-bytes=256MiB',
      '--demuxer-readahead-secs=60',
      '--mute=' + (config.muted ? 'yes' : 'no'),
      '--input-ipc-server=' + this.pipePath,
    ];
    this.proc = spawn(MPV_EXE, args, { stdio: 'ignore', windowsHide: false });
    this.proc.on('error', err => {
      console.error(`[screen ${this.index}] failed to launch mpv: ${err.message}`);
      this.proc = null;
    });
    this.proc.on('exit', () => {
      this.proc = null;
      this.nowPlaying = null;
      this.queuedNext = null;
      this.disconnect();
    });
    this.scheduleConnect(1200);
  }

  scheduleConnect(delay) {
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => this.connect(), delay);
  }

  connect() {
    if (!this.proc || this.sock) return;
    const sock = net.connect(this.pipePath);
    sock.on('connect', () => {
      this.sock = sock;
      // Watch the current file path so the control panel shows now-playing
      this.rawSend({ command: ['observe_property', 1, 'path'] });
      // Give this screen its first (distinct) video — staggered by screen
      // index so simultaneous startups don't collide
      setTimeout(() => this.seedIfIdle(), 300 + this.index * 200);
    });
    sock.on('data', chunk => this.onData(chunk));
    const dead = () => {
      if (this.sock === sock) this.sock = null;
      // mpv may still be starting up; retry while the process lives
      if (this.proc) this.scheduleConnect(1000);
    };
    sock.on('error', dead);
    sock.on('close', dead);
  }

  disconnect() {
    clearTimeout(this.connectTimer);
    if (this.sock) { this.sock.destroy(); this.sock = null; }
    for (const [, p] of this.pending) p.reject(new Error('disconnected'));
    this.pending.clear();
    this.buf = '';
  }

  onData(chunk) {
    this.buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.request_id && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        msg.error === 'success' ? p.resolve(msg.data) : p.reject(new Error(msg.error));
      } else if (msg.event === 'property-change' && msg.name === 'path') {
        const file = msg.data ? path.basename(String(msg.data)) : null;
        this.nowPlaying = file;
        if (file) {
          // The previously queued entry (if any) is now playing or was
          // replaced — either way it's no longer "queued".
          if (this.queuedNext === file) this.queuedNext = null;
          // Keep transitions seamless: line up the next pick right away
          // so prefetch-playlist can preload it.
          this.queueNext();
        }
      }
    }
  }

  rawSend(obj) {
    if (!this.sock) return false;
    try { this.sock.write(JSON.stringify(obj) + '\n'); return true; }
    catch (e) { return false; }
  }

  command(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('player not connected'));
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      if (!this.rawSend({ command: cmd, request_id: id })) {
        this.pending.delete(id);
        reject(new Error('write failed'));
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout'));
        }
      }, 3000);
    });
  }

  async stop() {
    clearTimeout(this.connectTimer);
    try { await this.command(['quit']); } catch (e) { /* fall through */ }
    if (this.proc) {
      const proc = this.proc;
      setTimeout(() => { try { proc.kill(); } catch (e) {} }, 1500);
    }
  }

  // Make sure exactly one more entry sits after the current one, chosen to
  // avoid what every other screen is playing or has queued.
  async queueNext() {
    if (this.queueing || !this.sock || this.locked) return;
    this.queueing = true;
    try {
      const count = await this.command(['get_property', 'playlist-count']);
      const pos = await this.command(['get_property', 'playlist-pos']);
      if (pos >= count - 1) {
        const file = pickFor(this);
        if (file) {
          this.queuedNext = file;
          await this.command(['loadfile', path.join(config.folder, file), 'append']);
        }
      }
      // Trim already-played entries so the playlist doesn't grow forever
      if (pos > 3) await this.command(['playlist-remove', 0]);
    } catch (e) {
      this.queuedNext = null;
    } finally {
      this.queueing = false;
    }
  }

  // If the player is sitting idle (nothing loaded), give it something to
  // play. Locked screens always get their pinned video, looping forever.
  async seedIfIdle() {
    if (!this.sock) return;
    try {
      const cur = await this.command(['get_property', 'path']).catch(() => null);

      if (this.locked) {
        const videos = listVideos() || [];
        if (!videos.includes(this.locked)) {
          // Pinned file vanished from the folder — release the lock and
          // fall back to random rotation rather than showing a dead screen.
          console.warn(`[screen ${this.index}] locked file "${this.locked}" is gone — unlocking`);
          logStall(`screen ${this.index} locked file "${this.locked}" missing — lock released`);
          this.locked = null;
          delete config.locks[this.index];
          saveConfig();
        } else {
          await this.command(['set_property', 'loop-file', 'inf']);
          if (!cur || path.basename(String(cur)) !== this.locked) {
            this.nowPlaying = this.locked;
            await this.command(['loadfile', path.join(config.folder, this.locked), 'replace']);
          }
          return;
        }
      }

      if (!cur) {
        const file = pickFor(this);
        if (file) {
          // Claim it immediately so screens seeding at the same moment
          // can't grab the same file before the load completes.
          this.nowPlaying = file;
          await this.command(['loadfile', path.join(config.folder, file), 'replace']);
        }
      } else {
        await this.queueNext();
      }
    } catch (e) { /* watchdog will retry */ }
  }

  // Pin one video to this screen: it plays immediately and loops forever
  // until unlocked. Survives restarts via config.json.
  async lock(file) {
    this.locked = file;
    this.queuedNext = null;
    config.locks[this.index] = file;
    saveConfig();
    try {
      await this.command(['set_property', 'loop-file', 'inf']);
      this.nowPlaying = file;
      await this.command(['loadfile', path.join(config.folder, file), 'replace']);
    } catch (e) { /* seedIfIdle will finish the job on the next tick */ }
  }

  // Release the pin: the video finishes its current loop, then the screen
  // rejoins random rotation seamlessly.
  async unlock() {
    this.locked = null;
    delete config.locks[this.index];
    saveConfig();
    try { await this.command(['set_property', 'loop-file', 'no']); } catch (e) {}
    this.queueNext();
  }

  // Watchdog tick: seed if idle, keep the queue stocked, and detect frozen
  // playback. If time-pos stops advancing while unpaused, first force-skip
  // to the next video; if the player stays frozen, restart the whole
  // mpv instance for this screen.
  async tick() {
    // A live MJPEG feed has no timeline, so time-pos never advances and the
    // freeze detector would "recover" a perfectly healthy takeover by skipping
    // off it after 15 seconds. Leave streaming screens alone.
    if (!this.sock || this.restarting || this.streaming) return;
    const cur = await this.command(['get_property', 'path']).catch(() => null);
    if (!cur) {
      this.lastTimePos = null;
      this.stallTicks = 0;
      return this.seedIfIdle();
    }
    this.queueNext();

    const t = await this.command(['get_property', 'time-pos']).catch(() => null);
    const paused = await this.command(['get_property', 'pause']).catch(() => false);
    if (paused || t === null) { this.stallTicks = 0; this.lastTimePos = t; return; }

    if (this.lastTimePos !== null && Math.abs(t - this.lastTimePos) < 0.05) {
      this.stallTicks++;
      if (this.stallTicks === 3) {
        // ~15s frozen: skip ahead (or reload the pinned file if locked)
        console.warn(`[screen ${this.index}] playback frozen — recovering`);
        logStall(`screen ${this.index} FROZE during "${this.nowPlaying}" at ${Math.round(t)}s — recovering`);
        if (this.locked) {
          this.command(['loadfile', path.join(config.folder, this.locked), 'replace']).catch(() => {});
        } else {
          this.command(['playlist-next', 'force']).catch(() => {});
        }
      } else if (this.stallTicks >= 6) {
        // Still frozen ~30s later: restart this screen's player entirely
        console.warn(`[screen ${this.index}] still frozen — restarting player`);
        logStall(`screen ${this.index} STILL FROZEN during "${this.nowPlaying}" — restarted mpv`);
        this.respawn();
      }
    } else {
      this.stallTicks = 0;
    }
    this.lastTimePos = t;
  }

  // ----- VS effect helpers -----
  // The video equalizer is a property set, so effects are applied and undone
  // without touching playback at all — the video keeps rolling underneath.
  setEq(props) {
    for (const [name, value] of Object.entries(props)) {
      this.rawSend({ command: ['set_property', name, value] });
    }
  }

  clearEq() {
    this.setEq({ brightness: 0, contrast: 0, saturation: 0, gamma: 0, hue: 0 });
  }

  // Big text burned over whatever is playing. level 0 keeps it visible even
  // though the players run with --no-osd-bar.
  showText(text, ms) {
    this.rawSend({ command: ['set_property', 'osd-font-size', config.osdFontSize || 96] });
    this.rawSend({ command: ['set_property', 'osd-align-x', 'center'] });
    this.rawSend({ command: ['set_property', 'osd-align-y', 'center'] });
    this.rawSend({ command: ['show-text', String(text), Math.round(ms), 0] });
  }

  playNow(file) {
    this.nowPlaying = file;
    this.rawSend({ command: ['loadfile', path.join(config.folder, file), 'replace'] });
  }

  // Play a live network stream (the other room's camera, relayed as MJPEG).
  // The players normally buffer ~60 seconds ahead, which is exactly wrong for
  // a live feed - it would show the room as it was a minute ago. Drop the
  // read-ahead for the duration, then put it back.
  playStream(url) {
    this.streaming = true;
    this.rawSend({ command: ['set_property', 'cache', 'no'] });
    this.rawSend({ command: ['set_property', 'demuxer-readahead-secs', 0] });
    this.rawSend({ command: ['set_property', 'demuxer-max-bytes', 4194304] });
    this.rawSend({ command: ['set_property', 'untimed', 'yes'] });
    this.nowPlaying = 'LIVE CAMERA';
    this.rawSend({ command: ['loadfile', url, 'replace'] });
  }

  // Undo playStream's buffering changes and return to the shuffle.
  endStream() {
    if (!this.streaming) return;
    this.streaming = false;
    this.rawSend({ command: ['set_property', 'untimed', 'no'] });
    this.rawSend({ command: ['set_property', 'cache', 'yes'] });
    this.rawSend({ command: ['set_property', 'demuxer-readahead-secs', 60] });
    this.rawSend({ command: ['set_property', 'demuxer-max-bytes', 268435456] });
    if (this.locked) this.playNow(this.locked);
    else this.rawSend({ command: ['playlist-next', 'force'] });
  }

  respawn() {
    if (this.restarting) return;
    this.restarting = true;
    this.stallTicks = 0;
    this.lastTimePos = null;
    const finish = () => {
      this.restarting = false;
      if (players.includes(this)) this.start();
    };
    if (this.proc) {
      this.proc.once('exit', () => setTimeout(finish, 1000));
      try { this.proc.kill(); } catch (e) { setTimeout(finish, 2000); }
      // Safety net in case the process refuses to die quietly
      setTimeout(() => { if (this.restarting && !this.proc) finish(); }, 5000);
    } else {
      setTimeout(finish, 1000);
    }
  }
}

// ---------- player pool ----------
let players = [];

// Pick a random video for one screen, avoiding duplicates across screens.
// Priority: never repeat this screen's current video, and avoid anything
// playing or queued on other screens. Only when the folder has fewer
// videos than needed does it relax those rules (in that order).
function pickFor(player) {
  const videos = listVideos() || [];
  if (videos.length === 0) return null;

  const onOtherScreens = new Set();
  for (const p of players) {
    if (p === player) continue;
    if (p.nowPlaying) onOtherScreens.add(p.nowPlaying);
    if (p.queuedNext) onOtherScreens.add(p.queuedNext);
    if (p.locked) onOtherScreens.add(p.locked);
  }
  const onThisScreen = new Set();
  if (player.nowPlaying) onThisScreen.add(player.nowPlaying);
  if (player.queuedNext) onThisScreen.add(player.queuedNext);

  let pool = videos.filter(v => !onOtherScreens.has(v) && !onThisScreen.has(v));
  if (pool.length === 0) pool = videos.filter(v => !onThisScreen.has(v));
  if (pool.length === 0) pool = videos;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------- VS sabotage effects ----------
// One effect at a time across all screens. Starting a new one cancels the
// previous one, and every effect carries an expiry so the walls recover even
// if whatever started it goes away.
const vsEffect = {
  name: null,
  until: 0,
  loop: null,
  expiry: null,
};

// A live takeover runs across all screens at once, so its timer is global too.
let streamTimer = null;

function endAllStreams() {
  clearTimeout(streamTimer);
  streamTimer = null;
  eachPlayer(p => p.endStream());
}

function eachPlayer(fn) {
  for (const p of players) {
    if (p.running && p.sock) {
      try { fn(p); } catch (e) { /* a single dead screen must not stop the rest */ }
    }
  }
}

function clearVsEffect() {
  if (vsEffect.loop) { clearInterval(vsEffect.loop); vsEffect.loop = null; }
  if (vsEffect.expiry) { clearTimeout(vsEffect.expiry); vsEffect.expiry = null; }
  vsEffect.name = null;
  vsEffect.until = 0;
  eachPlayer(p => p.clearEq());
}

// "Restore" has to undo a live takeover too, or the walls stay on the camera.
function restoreWalls() {
  clearVsEffect();
  endAllStreams();
}

function applyVsEffect(name, opts = {}) {
  clearVsEffect();
  const seconds = Math.max(0, Math.min(Number(opts.seconds) || 15, 300));

  switch (name) {
    case 'restore':
      return { ok: true, effect: 'restore' };

    case 'blackout':
      eachPlayer(p => p.setEq({ brightness: -100 }));
      break;

    case 'dim': {
      const level = Number(opts.level);
      const brightness = Number.isFinite(level) ? Math.max(-100, Math.min(0, level)) : -70;
      const props = { brightness };
      if (opts.desaturate !== false) props.saturation = -100;
      eachPlayer(p => p.setEq(props));
      break;
    }

    case 'desaturate':
      eachPlayer(p => p.setEq({ saturation: -100 }));
      break;

    case 'hue':
      eachPlayer(p => p.setEq({ hue: Number(opts.value) || 180 }));
      break;

    case 'flash': {
      // Slower than a lighting strobe on purpose: projectors have their own
      // response lag, and this reads better on a wall than a hard stutter.
      const period = Math.max(150, Number(opts.intervalMs) || 400);
      let on = false;
      vsEffect.loop = setInterval(() => {
        on = !on;
        eachPlayer(p => p.setEq({ brightness: on ? 100 : -100, contrast: on ? 60 : 0 }));
      }, period);
      break;
    }

    case 'glitch': {
      vsEffect.loop = setInterval(() => {
        const jitter = {
          hue: Math.round(-180 + Math.random() * 360),
          saturation: Math.round(-100 + Math.random() * 200),
          contrast: Math.round(-40 + Math.random() * 100),
          brightness: Math.round(-40 + Math.random() * 60),
        };
        eachPlayer(p => p.setEq(jitter));
      }, 110);
      break;
    }

    default:
      return { ok: false, error: `unknown effect "${name}"` };
  }

  vsEffect.name = name;
  vsEffect.until = Date.now() + seconds * 1000;
  vsEffect.expiry = setTimeout(clearVsEffect, seconds * 1000);
  logStall(`VS effect "${name}" for ${seconds}s`);
  return { ok: true, effect: name, seconds };
}

// Watchdog: every few seconds, make sure each running player has a video
// loaded and one queued, and that playback is actually advancing. Recovers
// automatically from idle screens, frozen playback, and crashed players.
setInterval(() => {
  for (const p of players) {
    if (p.running && p.sock) p.tick().catch(() => {});
    else if (!p.running && !p.restarting && players.some(q => q.running)) {
      // A player crashed while others are still going — bring it back
      p.respawn();
    }
  }
}, 5000);

async function startAll() {
  if (players.some(p => p.running)) return;
  MPV_EXE = findMpv();
  if (!MPV_EXE) {
    const msg = 'mpv.exe not found. Either put mpv.exe next to server.js, or set '
      + '"mpvPath" in config.json to its full location, then press Start again.';
    console.error(msg);
    throw new Error(msg);
  }
  console.log('Using mpv: ' + MPV_EXE);
  const count = await getScreenCount();
  players = [];
  for (let i = 0; i < count; i++) {
    const p = new Player(i);
    if (config.locks && config.locks[i]) p.locked = config.locks[i];
    players.push(p);
    p.start();
  }
  console.log(`Started ${count} player(s) — folder: ${config.folder}`);
}

async function stopAll() {
  restoreWalls(); // never leave the walls blacked out, strobing, or on a camera
  const list = players;
  players = []; // remove from the pool first so the watchdog won't revive them
  await Promise.all(list.map(p => p.stop()));
  console.log('Stopped all players');
}

// ---------- HTTP helpers ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    // The VS server and the operator dashboard both live on other hosts.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-VS-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('bad JSON')); }
    });
    req.on('error', reject);
  });
}

function statusPayload() {
  return {
    running: players.some(p => p.running),
    folder: config.folder,
    folderOk: listVideos() !== null,
    muted: config.muted,
    hostname: os.hostname(),
    mpvFound: !!(MPV_EXE || (MPV_EXE = findMpv())),
    mpvPath: MPV_EXE,
    screens: players.map(p => ({
      index: p.index,
      running: p.running,
      connected: !!p.sock,
      nowPlaying: p.nowPlaying,
      locked: p.locked,
    })),
    // VS layer: what the sabotage API is currently doing to these walls.
    vs: {
      streaming: players.some(p => p.streaming),
      effect: vsEffect.name,
      until: vsEffect.until || null,
      secondsLeft: vsEffect.until ? Math.max(0, Math.round((vsEffect.until - Date.now()) / 1000)) : 0,
      tokenRequired: !!config.vsToken,
    },
  };
}

// Shared secret with the VS server. Blank token = open, which is fine on an
// isolated room network but worth setting if the LAN carries guest wifi.
function vsAuthorised(req) {
  if (!config.vsToken) return true;
  return req.headers['x-vs-token'] === config.vsToken;
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = req.method + ' ' + url.pathname;

  try {
    if (route === 'GET /' ) {
      const html = fs.readFileSync(path.join(HERE, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (route === 'GET /api/status') return json(res, 200, statusPayload());

    if (route === 'GET /api/videos') {
      const v = listVideos();
      if (v === null) return json(res, 200, { ok: false, error: 'Folder not found or unreadable', videos: [] });
      return json(res, 200, { ok: true, videos: v });
    }

    if (route === 'POST /api/start') {
      await startAll();
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/stop') {
      await stopAll();
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/folder') {
      const body = await readBody(req);
      const folder = String(body.folder || '').trim();
      if (!folder) return json(res, 400, { ok: false, error: 'No folder given' });
      if (!fs.existsSync(folder)) return json(res, 400, { ok: false, error: 'That folder does not exist on the player PC' });
      config.folder = folder;
      saveConfig();
      // If players are running, restart them so they pick up the new folder
      const wasRunning = players.some(p => p.running);
      if (wasRunning) {
        await stopAll();
        setTimeout(() => startAll(), 2000);
      }
      return json(res, 200, { ok: true, restarted: wasRunning });
    }

    if (route === 'POST /api/play') {
      const body = await readBody(req);
      const idx = Number(body.screen);
      const file = String(body.file || '');
      const p = players[idx];
      if (!p || !p.running) return json(res, 400, { ok: false, error: 'That screen is not running' });
      const videos = listVideos() || [];
      if (!videos.includes(file)) return json(res, 400, { ok: false, error: 'File not found in the current folder' });
      if (p.locked) await p.unlock(); // a manual pick overrides the pin
      await p.command(['loadfile', path.join(config.folder, file), 'replace']);
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/lock') {
      const body = await readBody(req);
      const idx = Number(body.screen);
      const file = String(body.file || '');
      const p = players[idx];
      if (!p || !p.running) return json(res, 400, { ok: false, error: 'That screen is not running' });
      const videos = listVideos() || [];
      if (!videos.includes(file)) return json(res, 400, { ok: false, error: 'File not found in the current folder' });
      await p.lock(file);
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/unlock') {
      const body = await readBody(req);
      const p = players[Number(body.screen)];
      if (!p) return json(res, 400, { ok: false, error: 'No such screen' });
      await p.unlock();
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/skip') {
      const body = await readBody(req);
      const p = players[Number(body.screen)];
      if (!p || !p.running) return json(res, 400, { ok: false, error: 'That screen is not running' });
      if (p.locked) return json(res, 400, { ok: false, error: 'That screen is locked — unlock it first' });
      await p.command(['playlist-next', 'force']);
      return json(res, 200, { ok: true });
    }

    // ---------- VS sabotage API ----------
    if (route === 'POST /api/effect') {
      if (!vsAuthorised(req)) return json(res, 401, { ok: false, error: 'bad VS token' });
      const body = await readBody(req);
      const name = String(body.effect || '');
      if (name === 'restore') {
        restoreWalls();
        return json(res, 200, { ok: true, effect: 'restore' });
      }
      const result = applyVsEffect(name, body);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (route === 'POST /api/message') {
      if (!vsAuthorised(req)) return json(res, 401, { ok: false, error: 'bad VS token' });
      const body = await readBody(req);
      const text = String(body.text || '').slice(0, 120);
      const seconds = Math.max(1, Math.min(Number(body.seconds) || 5, 60));
      if (!text) return json(res, 400, { ok: false, error: 'no text given' });
      eachPlayer(p => p.showText(text, seconds * 1000));
      return json(res, 200, { ok: true, text, seconds });
    }

    if (route === 'POST /api/playall') {
      if (!vsAuthorised(req)) return json(res, 401, { ok: false, error: 'bad VS token' });
      const body = await readBody(req);
      const seconds = Math.max(0, Math.min(Number(body.seconds) || 0, 300));

      // Live stream: the other room's camera during a Wall Takeover.
      if (body.url) {
        const url = String(body.url);
        if (!/^https?:\/\//i.test(url)) {
          return json(res, 400, { ok: false, error: 'url must be http or https' });
        }
        clearVsEffect();          // a takeover replaces any running effect
        clearTimeout(streamTimer);
        eachPlayer(p => p.playStream(url));
        if (seconds) streamTimer = setTimeout(endAllStreams, seconds * 1000);
        logStall('VS live takeover from ' + url + ' for ' + seconds + 's');
        return json(res, 200, { ok: true, url, seconds, live: true });
      }

      const file = String(body.file || '');
      const videos = listVideos() || [];
      if (!videos.includes(file)) {
        return json(res, 400, { ok: false, error: 'File not found in the current folder' });
      }
      eachPlayer(p => p.playNow(file));

      // After the takeover window, kick every screen back into the shuffle.
      // Locked screens are left alone — the watchdog restores their pin.
      if (seconds) {
        setTimeout(() => {
          eachPlayer(p => {
            if (p.locked) p.playNow(p.locked);
            else p.rawSend({ command: ['playlist-next', 'force'] });
          });
        }, seconds * 1000);
      }
      return json(res, 200, { ok: true, file, seconds });
    }

    if (route === 'POST /api/mute') {
      const body = await readBody(req);
      config.muted = !!body.muted;
      saveConfig();
      for (const p of players) {
        if (p.sock) p.rawSend({ command: ['set_property', 'mute', config.muted] });
      }
      return json(res, 200, { ok: true, muted: config.muted });
    }

    json(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    json(res, 500, { ok: false, error: err.message });
  }
});

// If launched with "autostart" (the startup shortcut does this), begin
// playing shortly after the server comes up. The delay gives Windows time
// to finish logging in and wake up all the displays.
const AUTOSTART = process.argv.slice(2).some(a => a.replace(/^--/, '') === 'autostart');

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log('Wall Player control server running.');
  console.log('Open from any computer on the network:');
  for (const ip of ips) console.log(`  http://${ip}:${PORT}`);
  console.log(`Video folder: ${config.folder}`);
  if (AUTOSTART) {
    console.log('Autostart: players will begin in 10 seconds...');
    setTimeout(() => startAll().catch(e => console.error(e.message)), 10000);
  }
});

// Clean up mpv processes if the server window is closed
process.on('SIGINT', async () => { await stopAll(); process.exit(0); });
process.on('SIGTERM', async () => { await stopAll(); process.exit(0); });
