'use strict';

// VS Room Control — main server.
//
// Serves:
//   /table/?room=A    the touchscreen table UI for a room
//   /operator/        the game master dashboard for the VS layer
//   /api/*            REST for the operator, for Quandary webhooks, and for setup
//   socket.io         live state for tables + operator, and WebRTC signalling
//                     so each table can show the other room's camera
//
// Run this on ONE machine on the room network (either table PC, the Quandary
// PC, or a small box in the rack — it only needs to reach the lights, the two
// Wall Player PCs, and Quandary Control).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const configLib = require('./lib/config');
const logLib = require('./lib/log');
const log = logLib.scoped('server');
const { Engine } = require('./lib/engine');
const { QuandaryBridge } = require('./adapters/quandary');
const { CamRelay } = require('./lib/camrelay');
const sabotages = require('./lib/sabotages');
const minigames = require('./lib/minigames');

const config = configLib.load();
const ROOT = configLib.ROOT;
const PORT = config.port || 8990;
const HTTPS_PORT = config.httpsPort || 8443;

// ---------- bridges + engine ----------

const quandaryRooms = {};
for (const [key, room] of Object.entries(config.rooms)) {
  quandaryRooms[key] = room.quandaryRoomId || '';
}
const quandary = new QuandaryBridge(config.quandary, quandaryRooms);
const camRelay = new CamRelay();
const engine = new Engine(config, quandary, camRelay);
quandary.start();

// The Wall Player PCs fetch the camera stream from us over the LAN, so we need
// an address they can actually reach — never 127.0.0.1. Set "serverUrl" in
// config.json if this machine has several NICs and picks the wrong one.
function detectServerUrl() {
  if (config.serverUrl) return String(config.serverUrl).replace(/\/$/, '');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) return `http://${n.address}:${PORT}`;
    }
  }
  return `http://127.0.0.1:${PORT}`;
}
engine.serverUrl = detectServerUrl();

// ---------- static files ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(res, baseDir, relPath) {
  // Resolve inside baseDir only — never let a URL climb out of the folder.
  const clean = decodeURIComponent(relPath).replace(/\?.*$/, '');
  const full = path.resolve(baseDir, '.' + path.sep + clean.replace(/^[\\/]+/, ''));
  if (!full.startsWith(path.resolve(baseDir))) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  let target = full;
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, 'index.html');
    }
    if (!fs.existsSync(target)) return false;
    const body = fs.readFileSync(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return true;
  } catch (e) {
    log.error('static read failed', { target, error: e.message });
    res.writeHead(500).end('Server error');
    return true;
  }
}

// ---------- HTTP helpers ----------

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

// Camera frames arrive as raw JPEG bytes, not JSON.
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { req.destroy(); return reject(new Error('frame too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('bad JSON body')); }
    });
    req.on('error', reject);
  });
}

// The operator PIN is a "keep players out of the dashboard" measure, not real
// security — this whole system is meant to live on an isolated room network.
function operatorAllowed(req, url) {
  if (!config.operatorPin) return true;
  const supplied = req.headers['x-vs-pin'] || url.searchParams.get('pin') || '';
  return String(supplied) === String(config.operatorPin);
}

// ---------- server ----------

const requestHandler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = req.method + ' ' + url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-VS-Pin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  try {
    // ----- pages -----
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/operator/' });
      return res.end();
    }
    if (url.pathname === '/table' || url.pathname === '/table/') {
      return serveStatic(res, path.join(ROOT, 'table'), 'index.html') || res.writeHead(404).end();
    }
    if (url.pathname.startsWith('/table/')) {
      if (serveStatic(res, path.join(ROOT, 'table'), url.pathname.slice('/table/'.length))) return;
    }
    if (url.pathname === '/operator' || url.pathname === '/operator/') {
      return serveStatic(res, path.join(ROOT, 'operator'), 'index.html') || res.writeHead(404).end();
    }
    if (url.pathname.startsWith('/operator/')) {
      if (serveStatic(res, path.join(ROOT, 'operator'), url.pathname.slice('/operator/'.length))) return;
    }
    if (url.pathname.startsWith('/sounds/')) {
      if (serveStatic(res, path.join(ROOT, 'table', 'sounds'), url.pathname.slice('/sounds/'.length))) return;
      return json(res, 404, { ok: false, error: 'sound file not found — drop it in table/sounds/' });
    }

    // ----- live camera relay (Wall Takeover) -----
    // The table POSTs JPEG frames here; the projector PCs read them back as a
    // standard MJPEG stream. Both are deliberately unauthenticated: they carry
    // a room's own camera on an isolated room network, and adding a token here
    // would mean putting a secret into an mpv command line.
    if (url.pathname.startsWith('/api/camframe/')) {
      const key = url.pathname.slice('/api/camframe/'.length);
      if (!engine.room(key)) return json(res, 404, { ok: false, error: 'unknown room' });
      const buffer = await readRawBody(req, 3 * 1024 * 1024);
      const ok = camRelay.pushFrame(key, buffer);
      return json(res, ok ? 200 : 400, { ok, viewers: camRelay.viewers(key) });
    }

    if (url.pathname.startsWith('/api/camstream/')) {
      const key = url.pathname.slice('/api/camstream/'.length).replace(/\.mjpg$/, '');
      if (!engine.room(key)) return json(res, 404, { ok: false, error: 'unknown room' });
      return camRelay.attach(key, req, res);
    }

    // ----- public API (tables + setup) -----
    if (route === 'GET /api/health') {
      return json(res, 200, {
        ok: true,
        hostname: os.hostname(),
        rooms: Object.keys(config.rooms),
        matchArmed: engine.match.armed,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    if (route === 'GET /api/state') {
      const key = url.searchParams.get('room');
      const snap = engine.snapshot(key);
      if (!snap) return json(res, 404, { ok: false, error: 'unknown room' });
      return json(res, 200, { ok: true, state: snap });
    }

    if (route === 'GET /api/catalog') {
      return json(res, 200, {
        ok: true,
        sabotages: sabotages.CATALOG.map(s => ({
          id: s.id,
          label: sabotages.labelFor(s.id, config),
          blurb: s.blurb,
          icon: s.icon,
          needs: s.needs,
          enabled: sabotages.isEnabled(s.id, config),
          params: sabotages.paramsFor(s.id, config),
        })),
        minigames: minigames.CATALOG,
        sounds: config.sounds || [],
      });
    }

    // ----- webhook surface for Quandary Control -----
    // Quandary's variable triggers include a "send_webhook" action; point it at
    // these URLs to let a puzzle in the room drive the VS layer.
    if (url.pathname.startsWith('/api/hook/')) {
      const action = url.pathname.slice('/api/hook/'.length);
      const body = req.method === 'POST' ? await readBody(req) : {};
      const q = Object.fromEntries(url.searchParams.entries());
      const args = Object.assign({}, q, body);
      log.info(`Webhook /api/hook/${action}`, args);

      switch (action) {
        case 'arm':
          engine.startMatch();
          return json(res, 200, { ok: true });
        case 'disarm':
          engine.endMatch();
          return json(res, 200, { ok: true });
        case 'allstop':
          engine.allStop();
          return json(res, 200, { ok: true });
        case 'fire': {
          const result = engine.fire(args.from || null, args.to, args.sabotage, args.params);
          return json(res, result.ok ? 200 : 400, result);
        }
        case 'grant': {
          // Let a physical puzzle hand a team a free sabotage pick.
          const result = engine.grantSabotage(args.room);
          return json(res, result.ok ? 200 : 400, result);
        }
        default:
          return json(res, 404, { ok: false, error: `unknown hook "${action}"` });
      }
    }

    // ----- operator API -----
    if (url.pathname.startsWith('/api/operator') || url.pathname.startsWith('/api/admin')) {
      if (!operatorAllowed(req, url)) return json(res, 401, { ok: false, error: 'operator PIN required' });
    }

    // ----- settings screen -----
    // Only rules and sabotages are editable here. Room wiring, light drivers,
    // Wall Player URLs and tokens stay hand-edited: a dashboard that can break
    // the hardware bindings between two games is a liability, and getting them
    // wrong is not obvious until a sabotage silently does nothing.
    if (route === 'GET /api/admin/settings') {
      return json(res, 200, {
        ok: true,
        rules: config.rules,
        sabotages: sabotages.CATALOG.map(s => ({
          id: s.id,
          label: sabotages.labelFor(s.id, config),
          defaultLabel: s.label,
          blurb: s.blurb,
          icon: s.icon,
          needs: s.needs,
          enabled: sabotages.isEnabled(s.id, config),
          params: sabotages.paramsFor(s.id, config),
        })),
        minigames: minigames.CATALOG.map(m => ({
          id: m.id,
          name: m.name,
          blurb: m.blurb,
          defuse: m.defuse,
          timeLimit: m.timeLimit,
          enabled: (config.rules.minigames || []).includes(m.id),
        })),
      });
    }

    if (route === 'POST /api/admin/settings') {
      const body = await readBody(req);
      const patch = {};
      const problems = [];

      const num = (value, min, max, label) => {
        const v = Number(value);
        if (!Number.isFinite(v)) { problems.push(`${label} must be a number`); return null; }
        if (v < min || v > max) { problems.push(`${label} must be between ${min} and ${max}`); return null; }
        return v;
      };

      if (body.rules) {
        const r = {};
        const limits = {
          cooldownSeconds: [0, 3600],
          lockoutSeconds: [0, 3600],
          minigameTimeLimitSeconds: [0, 900],
          sabotageChoiceSeconds: [5, 300],
          maxSabotagesPerTeam: [0, 99],
          avoidRepeatCount: [0, 7],
        };
        for (const [key, [min, max]] of Object.entries(limits)) {
          if (body.rules[key] === undefined) continue;
          const v = num(body.rules[key], min, max, key);
          if (v !== null) r[key] = Math.round(v);
        }
        if (body.rules.armedOnly !== undefined) r.armedOnly = !!body.rules.armedOnly;

        if (body.rules.minigames !== undefined) {
          const wanted = Array.isArray(body.rules.minigames) ? body.rules.minigames : [];
          const known = wanted.filter(id => minigames.get(id));
          const unknown = wanted.filter(id => !minigames.get(id));
          if (unknown.length) problems.push(`unknown mini-games: ${unknown.join(', ')}`);
          // An empty pool is not a configuration, it is a room that cannot
          // deal a game at all — and the failure shows up as a dead button in
          // front of players rather than as an error here.
          if (!known.length) problems.push('at least one mini-game must stay enabled');
          else r.minigames = known;
        }
        patch.rules = r;
      }

      if (body.sabotages) {
        const out = {};
        for (const [id, entry] of Object.entries(body.sabotages)) {
          const def = sabotages.get(id);
          if (!def) { problems.push(`unknown sabotage: ${id}`); continue; }
          const clean = {};
          if (entry.enabled !== undefined) clean.enabled = !!entry.enabled;
          if (entry.label !== undefined) {
            const label = String(entry.label).trim().slice(0, 40);
            if (label) clean.label = label;
          }
          // Only keys the catalog already declares as numeric defaults are
          // writable, so the screen cannot invent parameters the sabotage
          // will never read.
          for (const [key, fallback] of Object.entries(def.defaults || {})) {
            if (typeof fallback !== 'number' || entry[key] === undefined) continue;
            const v = num(entry[key], 0, 86400, `${id}.${key}`);
            if (v !== null) clean[key] = v;
          }
          out[id] = clean;
        }
        patch.sabotages = out;
      }

      if (problems.length) return json(res, 400, { ok: false, error: problems.join('; ') });
      if (!patch.rules && !patch.sabotages) {
        return json(res, 400, { ok: false, error: 'nothing to change' });
      }

      configLib.savePatch(patch);
      log.info('settings updated', { sections: Object.keys(patch) });
      // Push the new numbers straight to the tables and the dashboard, so the
      // cooldown a player is watching matches what was just saved.
      io.to('operators').emit('operator', engine.operatorSnapshot());
      for (const key of Object.keys(config.rooms)) {
        io.to('table:' + key).emit('state', engine.snapshot(key));
      }
      return json(res, 200, { ok: true, rules: config.rules });
    }

    if (route === 'GET /api/operator') {
      return json(res, 200, { ok: true, state: engine.operatorSnapshot() });
    }

    if (route === 'GET /api/operator/logs') {
      const since = Number(url.searchParams.get('since') || 0);
      return json(res, 200, { ok: true, entries: logLib.recent(since) });
    }

    if (route === 'POST /api/operator/match') {
      const body = await readBody(req);
      if (body.action === 'start') engine.startMatch();
      else if (body.action === 'end') engine.endMatch();
      else if (body.action === 'allstop') engine.allStop();
      else return json(res, 400, { ok: false, error: 'action must be start, end or allstop' });
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/operator/fire') {
      const body = await readBody(req);
      const result = engine.fire(body.from || null, body.to, body.sabotage, body.params);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (route === 'POST /api/operator/lockout') {
      const body = await readBody(req);
      const r = engine.room(body.room);
      if (!r) return json(res, 400, { ok: false, error: 'unknown room' });
      r.lockoutUntil = body.clear ? 0 : Date.now() + (Number(body.seconds) || 300) * 1000;
      engine.pushRoom(body.room);
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/operator/cooldown') {
      const body = await readBody(req);
      const r = engine.room(body.room);
      if (!r) return json(res, 400, { ok: false, error: 'unknown room' });
      r.cooldownUntil = body.clear ? 0 : Date.now() + (Number(body.seconds) || 60) * 1000;
      engine.pushRoom(body.room);
      return json(res, 200, { ok: true });
    }

    if (route === 'GET /api/operator/probe') {
      const out = {};
      for (const key of Object.keys(config.rooms)) {
        const r = engine.room(key);
        out[key] = {
          lights: await r.lights.probe().catch(e => ({ ok: false, error: e.message })),
          wallPlayer: await r.wall.status(),
          quandary: {
            linked: quandary.isConnected(key),
            roomId: quandary.roomId(key),
            timer: quandary.timerState(key),
          },
          tableConnected: r.tableConnected,
        };
      }
      return json(res, 200, { ok: true, probe: out, cameras: camRelay.stats(), serverUrl: engine.serverUrl });
    }

    if (route === 'GET /api/operator/quandary-rooms') {
      return json(res, 200, { ok: true, rooms: await quandary.listRooms() });
    }

    return json(res, 404, { ok: false, error: 'not found', path: url.pathname });
  } catch (err) {
    log.error('request failed', { path: url.pathname, error: err.message });
    return json(res, 500, { ok: false, error: err.message });
  }
};

// ---------- listeners ----------

// Plain HTTP is always on. The Wall Player PCs pull the camera relay with
// mpv and Quandary posts webhooks; neither should have to trust a private
// certificate authority to do it.
const server = http.createServer(requestHandler);

// HTTPS is optional and purely additive. Chrome only hands out cameras on a
// secure origin, so a table served over TLS needs no
// --unsafely-treat-insecure-origin-as-secure flag and no throwaway profile.
// Point the tables at HTTPS_PORT and leave everything else on PORT.
let httpsServer = null;
if (config.tls && config.tls.enabled) {
  try {
    httpsServer = https.createServer({
      key: fs.readFileSync(path.resolve(ROOT, config.tls.key)),
      cert: fs.readFileSync(path.resolve(ROOT, config.tls.cert)),
    }, requestHandler);
  } catch (err) {
    // A missing or unreadable cert must not take the whole room offline —
    // HTTP still works, it just costs the tables the browser flag again.
    log.error('TLS is configured but could not start — serving HTTP only', {
      error: err.message,
    });
    httpsServer = null;
  }
}

// ---------- socket.io ----------

const io = new Server(server, { cors: { origin: '*' } });
if (httpsServer) io.attach(httpsServer, { cors: { origin: '*' } });

// Engine pushes go out through here. roomKey === null means "operators only".
engine.emit = (roomKey, event, payload) => {
  if (roomKey === null) io.to('operators').emit(event, payload);
  else io.to('table:' + roomKey).emit(event, payload);
};

function tablesOnline() {
  return Object.keys(config.rooms).filter(k => engine.room(k).tableConnected);
}

// Decide who makes the WebRTC offer so both tables don't offer at once.
function negotiateVideo() {
  const online = tablesOnline().sort();
  if (online.length < 2) return;
  const [first, second] = online;
  io.to('table:' + first).emit('rtc:initiate', { peer: second });
  io.to('table:' + second).emit('rtc:standby', { peer: first });
}

io.on('connection', socket => {
  socket.data.role = null;
  socket.data.room = null;

  socket.on('hello', ({ role, room } = {}) => {
    if (role === 'operator') {
      socket.data.role = 'operator';
      socket.join('operators');
      socket.emit('operator', engine.operatorSnapshot());
      log.info('Operator dashboard connected');
      return;
    }
    if (role === 'table' && engine.room(room)) {
      socket.data.role = 'table';
      socket.data.room = room;
      socket.join('table:' + room);
      engine.setTableConnected(room, true);
      socket.emit('state', engine.snapshot(room));
      socket.emit('catalog', { sounds: config.sounds || [] });
      negotiateVideo();
      return;
    }
    socket.emit('toast', { text: 'Unknown room — check the ?room= on this table\'s URL.', tone: 'bad' });
  });

  // ----- table actions -----
  const requireTable = fn => (payload, ack) => {
    const room = socket.data.room;
    if (socket.data.role !== 'table' || !room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'not a table client' });
      return;
    }
    const result = fn(room, payload || {}) || { ok: true };
    if (typeof ack === 'function') ack(result);
  };

  socket.on('game:request', requireTable(room => engine.requestGame(room)));
  socket.on('game:result', requireTable((room, p) => engine.gameResult(room, p.token, !!p.won)));
  socket.on('game:abandon', requireTable((room, p) => engine.abandonGame(room, p.token)));
  socket.on('sabotage:choose', requireTable((room, p) => engine.chooseSabotage(room, p.token, p.id)));
  socket.on('sound:fire', requireTable((room, p) => engine.fireSound(room, p.soundId)));
  socket.on('defuse:result', requireTable((room, p) => engine.defuseResult(room, p.token, !!p.success)));

  // ----- WebRTC signalling relay (camera feed between the two tables) -----
  socket.on('rtc:signal', ({ to, data } = {}) => {
    if (!engine.room(to)) return;
    io.to('table:' + to).emit('rtc:signal', { from: socket.data.room, data });
  });

  socket.on('disconnect', () => {
    if (socket.data.role === 'table' && socket.data.room) {
      // Only mark the room offline if no other tab for that room is left
      // (a reload briefly overlaps the old and new connection).
      const remaining = io.sockets.adapter.rooms.get('table:' + socket.data.room);
      if (!remaining || remaining.size === 0) {
        engine.setTableConnected(socket.data.room, false);
        io.emit('rtc:peer-gone', { peer: socket.data.room });
      }
    }
  });
});

// Keep the operator dashboard's clock-driven fields fresh.
setInterval(() => io.to('operators').emit('operator', engine.operatorSnapshot()), 2000);

// ---------- startup ----------

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  }
  console.log('');
  console.log('  VS Room Control is up.');
  console.log('');
  for (const ip of ips) {
    console.log(`  Operator dashboard : http://${ip}:${PORT}/operator/`);
    for (const key of Object.keys(config.rooms)) {
      console.log(`  Table ${key.padEnd(12)}: http://${ip}:${PORT}/table/?room=${key}`);
    }
    if (httpsServer) {
      console.log('');
      console.log('  HTTPS is on. Point the tables at these — a secure origin');
      console.log('  gets the camera with no browser flags:');
      for (const key of Object.keys(config.rooms)) {
        console.log(`  Table ${key.padEnd(12)}: https://${ip}:${HTTPS_PORT}/table/?room=${key}`);
      }
    }
    break;
  }
  console.log('');
  for (const [key, room] of Object.entries(config.rooms)) {
    console.log(`  Room ${key} "${room.name}" -> opponent ${room.opponent || '(none!)'}`);
  }
  console.log('');
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    log.info(`HTTPS listening on ${HTTPS_PORT}`);
  });
  httpsServer.on('error', err => {
    log.error('HTTPS listener failed — HTTP is unaffected', { error: err.message });
  });
}

function shutdown(signal) {
  log.info(`${signal} received — restoring rooms and shutting down`);
  engine.shutdown();
  quandary.stopAll();
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', err => {
  log.error('uncaught exception', { error: err.message, stack: err.stack });
});
