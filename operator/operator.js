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
    socket.emit('hello', { role: 'operator' });
    $('link').innerHTML = '<span class="live">● CONNECTED</span>';
  });
  socket.on('disconnect', () => { $('link').textContent = 'server unreachable'; });
  socket.on('operator', data => { snapshot = data; render(); });

  api('/api/catalog').then(data => { catalog = data; render(); }).catch(() => {});
  pollLog();
  setInterval(pollLog, 2000);
  // Countdowns are drawn from timestamps, so repaint even between pushes.
  setInterval(render, 1000);
})();
