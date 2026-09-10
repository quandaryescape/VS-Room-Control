/* Operator dashboard for the VS layer.
 *
 * This is deliberately separate from the Quandary Control GM screen: the GM
 * keeps running the escape room in Quandary as normal, and only comes here to
 * arm the VS round, watch what the teams are doing to each other, or pull the
 * plug when a sabotage lands at a bad moment.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const pin = new URLSearchParams(location.search).get('pin') || '';

  // The settings screen is behind the same PIN. Without carrying it across,
  // the link lands on a page that can only report that it was refused.
  if (pin) {
    const link = document.getElementById('settingsLink');
    if (link) link.href = 'settings.html?pin=' + encodeURIComponent(pin);
  }

  let snapshot = null;
  let catalog = null;
  let lastLogTs = 0;

  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = ''; }, 2800);
  }

  async function api(path, body) {
    const opts = {
      method: body === undefined ? 'GET' : 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, pin ? { 'X-VS-Pin': pin } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const res = await fetch(path, opts);
    const data = await res.json();
    if (data.ok === false) throw new Error(data.error || 'request failed');
    return data;
  }

  function mmss(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ------------------------------------------------------------------ render

  function render() {
    if (!snapshot) return;

    const armed = snapshot.match.armed;
    const pill = $('matchPill');
    pill.textContent = armed ? 'MATCH ARMED' : 'MATCH IDLE';
    pill.className = 'matchpill' + (armed ? ' on' : '');
    $('armBtn').disabled = armed;
    $('endBtn').disabled = !armed;

    $('rooms').innerHTML = snapshot.rooms.map(roomCard).join('');
    wireRoomButtons();
  }

  function roomCard(room) {
    const now = Date.now();
    const timer = room.timer;
    const caps = room.capabilities || {};
    const lockedOut = room.lockoutUntil > now;

    const capChip = (key, label) =>
      `<span class="cap ${caps[key] ? 'on' : ''}">${label}</span>`;

    const effects = room.incoming.length
      ? room.incoming.map(e =>
        `<span class="fx">${esc(e.icon || '')} ${esc(e.label)} · ${mmss((e.until - now) / 1000)}</span>`).join('')
      : '<span class="muted">no active effects</span>';

    const fireButtons = (catalog ? catalog.sabotages : [])
      .filter(s => s.enabled)
      .map(s => `<button data-fire="${esc(s.id)}" data-target="${esc(room.key)}" title="${esc(s.blurb)}">${esc(s.icon)} ${esc(s.label)}</button>`)
      .join('');

    return `
    <div class="room ${lockedOut ? 'locked' : ''}">
      <h2>
        <span>${esc(room.name)} <span class="muted">(${esc(room.key)})</span></span>
        <span class="phase ${esc(room.phase)}">${esc(room.phase.toUpperCase())}</span>
      </h2>
      <div class="body">
        <div class="grid2">
          <div class="stat">
            <span class="k">CLOCK</span>
            <span class="v ${room.spedUp ? 'bad' : ''}">${timer ? mmss(timer.remaining) : '--:--'}${room.spedUp ? ' ⏩' : ''}</span>
          </div>
          <div class="stat">
            <span class="k">SABOTAGES SENT</span>
            <span class="v">${room.sabotagesUsed}</span>
          </div>
          <div class="stat">
            <span class="k">COOLDOWN</span>
            <span class="v">${room.cooldownUntil > now ? mmss((room.cooldownUntil - now) / 1000) : '—'}</span>
          </div>
          <div class="stat">
            <span class="k">LOCKOUT</span>
            <span class="v ${lockedOut ? 'bad' : ''}">${lockedOut ? mmss((room.lockoutUntil - now) / 1000) : '—'}</span>
          </div>
        </div>

        <div class="caps">
          ${capChip('audio', 'TABLE')}
          ${capChip('lights', 'LIGHTS')}
          ${capChip('wallplayer', 'WALLS')}
          ${capChip('quandary', 'QUANDARY')}
          <span class="cap ${room.wallOnline ? 'on' : ''}">WALL PC ${room.wallOnline === null ? '?' : room.wallOnline ? 'UP' : 'DOWN'}</span>
        </div>

        <div>
          <span class="k muted">INCOMING</span>
          <div class="effects">${effects}</div>
        </div>

        <div class="rowbtns">
          <button class="sm ghost" data-clear-lockout="${esc(room.key)}" ${lockedOut ? '' : 'disabled'}>Clear lockout</button>
          <button class="sm ghost" data-clear-cooldown="${esc(room.key)}" ${room.cooldownUntil > now ? '' : 'disabled'}>Clear cooldown</button>
          <button class="sm ghost" data-lockout="${esc(room.key)}">Lock out 5 min</button>
        </div>

        <div>
          <span class="k muted">FIRE AT ${esc(room.name.toUpperCase())}</span>
          <div class="fire">${fireButtons || '<span class="muted">catalog loading…</span>'}</div>
        </div>
      </div>
    </div>`;
  }

  function wireRoomButtons() {
    for (const button of document.querySelectorAll('[data-fire]')) {
      button.addEventListener('click', async () => {
        try {
          await api('/api/operator/fire', { to: button.dataset.target, sabotage: button.dataset.fire });
          toast('Fired ' + button.dataset.fire + ' at ' + button.dataset.target);
        } catch (e) { toast(e.message, true); }
      });
    }
    for (const button of document.querySelectorAll('[data-clear-lockout]')) {
      button.addEventListener('click', () =>
        api('/api/operator/lockout', { room: button.dataset.clearLockout, clear: true })
          .then(() => toast('Lockout cleared')).catch(e => toast(e.message, true)));
    }
    for (const button of document.querySelectorAll('[data-clear-cooldown]')) {
      button.addEventListener('click', () =>
        api('/api/operator/cooldown', { room: button.dataset.clearCooldown, clear: true })
          .then(() => toast('Cooldown cleared')).catch(e => toast(e.message, true)));
    }
    for (const button of document.querySelectorAll('[data-lockout]')) {
      button.addEventListener('click', () =>
        api('/api/operator/lockout', { room: button.dataset.lockout, seconds: 300 })
          .then(() => toast('Locked out for 5 minutes')).catch(e => toast(e.message, true)));
    }
  }

  // ---------------------------------------------------------------- cameras
  //
  // Built once and then updated in place, unlike the room cards: those are
  // rebuilt every second, and a hold-to-steer button that is replaced mid-press
  // never hears the mouse come back up.

  let cams = null;
  let camDeniedAt = 0;
  const LOCKS = [
    ['open', 'Both teams'],
    ['owner', 'Own team only'],
    ['gm', 'GM only'],
  ];

  function camEmit(event, payload, onOk) {
    socket.emit(event, payload, result => {
      if (result && result.ok) { if (onOk) onOk(); return; }
      // Held buttons repeat several times a second; one toast is enough.
      if (Date.now() - camDeniedAt > 2500) {
        camDeniedAt = Date.now();
        toast((result && result.error) || 'camera command failed', true);
      }
    });
  }

  function holderText(cam) {
    if (!cam.holder) return 'nobody';
    if (cam.holder === 'gm') return 'GM';
    if (cam.holder === 'owner') return esc(cam.name) + ' (own team)';
    return esc(cam.opponentName || 'the other room') + ' (other team)';
  }

  function camCard(key) {
    return `
    <div class="cam" data-cam="${esc(key)}">
      <div class="info">
        <div class="title"></div>
        <div class="caps"></div>
        <div class="who"></div>
        <div class="locks">${LOCKS.map(([id, label]) =>
          `<button class="sm" data-lock="${id}">${label}</button>`).join('')}</div>
      </div>
      <div class="pad">
        <button class="u" data-tilt="1" title="Tilt up">▲</button>
        <button class="l" data-pan="-1" title="Pan left">◀</button>
        <button class="h" data-home title="Recentre">⌂</button>
        <button class="r" data-pan="1" title="Pan right">▶</button>
        <button class="d" data-tilt="-1" title="Tilt down">▼</button>
        <button class="zi" data-zoom="1" title="Zoom in">+</button>
        <button class="zo" data-zoom="-1" title="Zoom out">−</button>
      </div>
    </div>`;
  }

  function renderCams() {
    const host = $('cams');
    const keys = Object.keys(cams || {});
    if (!keys.length) return;

    if (host.dataset.keys !== keys.join(',')) {
      host.dataset.keys = keys.join(',');
      host.innerHTML = keys.map(camCard).join('');
      for (const card of host.querySelectorAll('[data-cam]')) {
        const room = card.dataset.cam;
        VSCamPad(card.querySelector('.pad'), {
          drive: vector => camEmit('cam:drive', { room, vector }),
          home: () => camEmit('cam:home', { room }),
        });
        for (const button of card.querySelectorAll('[data-lock]')) {
          button.addEventListener('click', () =>
            camEmit('cam:lock', { room, lock: button.dataset.lock },
              () => toast(cams[room].name + ' camera: ' + button.textContent)));
        }
      }
    }

    for (const card of host.querySelectorAll('[data-cam]')) {
      const cam = cams[card.dataset.cam];
      const caps = cam.caps || {};
      card.querySelector('.title').textContent = cam.name + ' camera';
      card.querySelector('.caps').innerHTML = !cam.enabled
        ? '<span class="cap">STEERING OFF IN CONFIG</span>'
        : !cam.caps
          ? '<span class="cap">TABLE OFFLINE</span>'
          : ['pan', 'tilt', 'zoom'].map(a => `<span class="cap ${caps[a] ? 'on' : ''}">${a.toUpperCase()}</span>`).join('');
      card.querySelector('.who').innerHTML = 'Steering: <b>' + holderText(cam) + '</b>';
      for (const button of card.querySelectorAll('[data-lock]')) {
        button.classList.toggle('on', button.dataset.lock === cam.lock);
      }
      const pad = card.querySelector('.pad');
      pad.classList.toggle('dead', !(cam.enabled && (caps.pan || caps.tilt || caps.zoom)));
      for (const axis of ['pan', 'tilt', 'zoom']) {
        for (const button of pad.querySelectorAll('[data-' + axis + ']')) button.hidden = !!cam.caps && !caps[axis];
      }
    }
  }

  // -------------------------------------------------------------------- log

  function renderLog(entries) {
    if (!entries.length) return;
    const log = $('log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    for (const entry of entries) {
      lastLogTs = Math.max(lastLogTs, entry.t);
      const row = document.createElement('div');
      row.className = entry.level;
      row.innerHTML =
        `<span class="t">${new Date(entry.t).toLocaleTimeString('en-GB', { hour12: false })}</span>` +
        `<span class="s">${esc(entry.scope)}</span>` +
        `<span class="m">${esc(entry.msg)}${entry.extra ? ' ' + esc(JSON.stringify(entry.extra)) : ''}</span>`;
      log.appendChild(row);
    }
    while (log.children.length > 300) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  async function pollLog() {
    try {
      const data = await api('/api/operator/logs?since=' + lastLogTs);
      renderLog(data.entries || []);
    } catch (e) { /* the socket will report the outage */ }
  }

  // ----------------------------------------------------------------- wiring

  $('armBtn').addEventListener('click', () =>
    api('/api/operator/match', { action: 'start' }).then(() => toast('Match armed')).catch(e => toast(e.message, true)));
  $('endBtn').addEventListener('click', () =>
    api('/api/operator/match', { action: 'end' }).then(() => toast('Match ended')).catch(e => toast(e.message, true)));
  $('stopBtn').addEventListener('click', () =>
    api('/api/operator/match', { action: 'allstop' }).then(() => toast('All effects cancelled')).catch(e => toast(e.message, true)));

  $('probeBtn').addEventListener('click', async () => {
    $('probe').textContent = 'probing…';
    try {
      const data = await api('/api/operator/probe');
      $('probe').textContent = JSON.stringify(data.probe, null, 2);
    } catch (e) {
      $('probe').textContent = 'probe failed: ' + e.message;
    }
  });

  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    // The PIN rides along so the server lets this dashboard steer cameras.
    socket.emit('hello', { role: 'operator', pin });
    $('link').innerHTML = '<span class="live">● CONNECTED</span>';
  });
  socket.on('disconnect', () => { $('link').textContent = 'server unreachable'; });
  socket.on('operator', data => { snapshot = data; render(); });
  socket.on('cam:all', data => { cams = data; renderCams(); });

  api('/api/catalog').then(data => { catalog = data; render(); }).catch(() => {});
  pollLog();
  setInterval(pollLog, 2000);
  // Countdowns are drawn from timestamps, so repaint even between pushes.
  setInterval(render, 1000);
})();
