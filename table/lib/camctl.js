/* Moves this table's own camera: pan, tilt and zoom on an OBSBOT Tiny 4K, or
 * any UVC camera that exposes PTZ controls.
 *
 * This file only drives the motor. It never decides who is allowed to: every
 * steering input — this table's own buttons included — goes to the VS server,
 * which ranks game master > this team > the other team and sends a single
 * stream of commands back here (server/lib/camcontrol.js).
 *
 * A command is a velocity ("pan left at full speed") and it only lasts
 * DRIVE_TTL_MS; the sender repeats it while a button is held. If the other
 * table crashes, the network blips, or a release goes missing, the camera
 * stops on its own within half a second instead of grinding into its end stop.
 *
 * Chrome moves the motor through MediaStreamTrack constraints, which it only
 * exposes when the camera was opened asking for pan/tilt/zoom (see video.js).
 * Positions are kept here normalised — pan and tilt -1..1 with 0 at centre,
 * zoom 0 (widest) to 1 (tightest) — and converted to whatever units and range
 * the camera itself reports, so nothing here is specific to one model.
 */
(function () {
  'use strict';

  const AXES = ['pan', 'tilt', 'zoom'];
  const TICK_MS = 50;
  const DRIVE_TTL_MS = 450;
  // At most one motor command this often (see flush).
  const MIN_APPLY_MS = 125;
  // Full-deflection speed in normalised units per second: pan and tilt cross
  // their whole range in about four seconds, zoom in about two.
  const SPEED = { pan: 0.5, tilt: 0.5, zoom: 0.5 };

  let socket = null;
  let track = null;
  let range = {};             // axis -> { min, max, step }, only for axes this camera has
  const pos = { pan: 0, tilt: 0, zoom: 0 };
  let vector = null;
  let vectorUntil = 0;
  let lastTick = 0;
  let queued = null;
  let lastRequested = null;
  let applying = false;
  let lastApplyAt = 0;
  let flushTimer = null;
  let wired = false;
  let diag = null;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function readRanges(t) {
    const out = {};
    const caps = t && t.getCapabilities ? t.getCapabilities() : {};
    for (const axis of AXES) {
      const c = caps[axis];
      if (c && typeof c.min === 'number' && typeof c.max === 'number' && c.max > c.min) {
        out[axis] = { min: c.min, max: c.max, step: c.step > 0 ? c.step : 0 };
      }
    }
    return out;
  }

  function toNorm(axis, value) {
    const r = range[axis];
    if (axis === 'zoom') return clamp((value - r.min) / (r.max - r.min), 0, 1);
    return clamp((value - (r.min + r.max) / 2) / ((r.max - r.min) / 2), -1, 1);
  }

  function toDevice(axis, n) {
    const r = range[axis];
    let value = axis === 'zoom'
      ? r.min + n * (r.max - r.min)
      : (r.min + r.max) / 2 + n * (r.max - r.min) / 2;
    if (r.step) value = r.min + Math.round((value - r.min) / r.step) * r.step;
    return clamp(value, r.min, r.max);
  }

  // Start from wherever the camera really is: it keeps its position across a
  // page reload, and someone may have moved it from the OBSBOT app.
  // Also records it as what was last sent, so the first command after this
  // carries only the axes that actually move.
  function readPosition() {
    const settings = track && track.getSettings ? track.getSettings() : {};
    for (const axis of Object.keys(range)) {
      if (typeof settings[axis] !== 'number') continue;
      pos[axis] = toNorm(axis, settings[axis]);
      lastRequested = Object.assign({}, lastRequested, { [axis]: settings[axis] });
    }
  }

  function moveTo(target) {
    const changed = {};
    for (const axis of Object.keys(range)) {
      const n = Number(target[axis]);
      if (Number.isFinite(n)) pos[axis] = axis === 'zoom' ? clamp(n, 0, 1) : clamp(n, -1, 1);
      const value = toDevice(axis, pos[axis]);
      // Only the axes that actually move. Each one is a separate USB control
      // request to the camera, so panning shouldn't also re-send tilt and zoom
      // every time — and a button held against an end stop sends nothing.
      if (!lastRequested || lastRequested[axis] !== value) changed[axis] = value;
    }
    if (!Object.keys(changed).length) return;
    lastRequested = Object.assign({}, lastRequested, changed);
    queued = Object.assign(queued || {}, changed);
    flush();
  }

  // One applyConstraints in flight at a time, and no more than one every
  // MIN_APPLY_MS. Each call becomes USB control traffic to the camera, and
  // letting it pile up makes the camera keep moving after the button is
  // released. A newer target simply replaces one not yet sent; the gimbal
  // glides between targets on its own, so the motion stays smooth.
  function flush() {
    if (applying || !queued || !track) return;
    const wait = MIN_APPLY_MS - (Date.now() - lastApplyAt);
    if (wait > 0) {
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, wait);
      return;
    }
    const c = queued;
    queued = null;
    applying = true;
    lastApplyAt = Date.now();
    track.applyConstraints({ advanced: [c] })
      .catch(err => console.warn('[ptz] camera refused', c, err && err.message))
      .finally(() => { applying = false; flush(); });
  }

  function tick() {
    const now = Date.now();
    const dt = Math.min(0.2, (now - lastTick) / 1000);
    lastTick = now;
    if (!vector) return;
    if (now > vectorUntil) { vector = null; return; }
    // Pan and tilt slow down as the camera zooms in, so the picture slides at
    // about the same apparent speed at 4x as at 1x instead of whipping past.
    const fine = range.zoom ? 1 / (1 + 3 * pos.zoom) : 1;
    moveTo({
      pan: pos.pan + vector.pan * SPEED.pan * fine * dt,
      tilt: pos.tilt + vector.tilt * SPEED.tilt * fine * dt,
      zoom: pos.zoom + vector.zoom * SPEED.zoom * dt,
    });
  }

  // What the dashboard needs to explain a camera that can't be steered:
  // which camera actually opened, whether this browser can do PTZ at all,
  // and whether it has been allowed to move the camera.
  async function diagnose(t) {
    const d = {
      label: t ? t.label : null,
      browser: (navigator.userAgent.match(/(?:Chrome|Chromium|Edg)\/\d+/) || ['unknown'])[0],
      browserPtz: false,
      ptzPermission: 'unknown',
      reported: [],
    };
    try {
      const supported = navigator.mediaDevices.getSupportedConstraints();
      d.browserPtz = !!(supported.pan && supported.tilt && supported.zoom);
    } catch (e) {}
    try {
      d.ptzPermission = (await navigator.permissions.query({ name: 'camera', panTiltZoom: true })).state;
    } catch (e) {}
    const caps = t && t.getCapabilities ? t.getCapabilities() : {};
    d.reported = AXES.filter(a => caps[a]).map(a => a + ' ' + caps[a].min + '..' + caps[a].max);
    return d;
  }

  function reportCaps() {
    // Only on a live connection. socket.io flushes buffered emits before the
    // 'connect' handlers run, which would put this ahead of the table's hello
    // and get it refused; the 'connect' listener below covers that case.
    // It also waits for the diagnosis, so the event log gets one line with
    // the reason rather than a bare "no PTZ" followed by the explained one.
    if (!socket || !socket.connected || !diag) return;
    socket.emit('cam:caps', { caps: { pan: !!range.pan, tilt: !!range.tilt, zoom: !!range.zoom }, diag });
  }

  window.VSCamCtl = {
    // Call once the camera has opened — or failed to, with a null stream, so
    // the other side learns there is nothing to steer.
    attach(stream, sock) {
      socket = sock;
      track = stream ? stream.getVideoTracks()[0] || null : null;
      range = readRanges(track);
      vector = null;
      queued = null;
      lastRequested = null;
      readPosition();

      if (!wired) {
        wired = true;
        socket.on('connect', reportCaps);
        socket.on('cam:drive', ({ vector: v } = {}) => {
          if (!track || !v) return;
          const moving = v.pan || v.tilt || v.zoom;
          if (moving && !vector) readPosition();
          vector = moving ? { pan: +v.pan || 0, tilt: +v.tilt || 0, zoom: +v.zoom || 0 } : null;
          vectorUntil = Date.now() + DRIVE_TTL_MS;
        });
        socket.on('cam:home', ({ position } = {}) => {
          if (!track || !position) return;
          vector = null;
          moveTo(position);
        });
        lastTick = Date.now();
        setInterval(tick, TICK_MS);
      }

      // Report once the diagnosis is in, so the dashboard can say WHY a
      // camera can't be steered rather than just that it can't.
      diag = null;
      diagnose(track)
        .then(d => { diag = d; console.info('[ptz] diagnosis', d); }, () => { diag = {}; })
        .then(reportCaps);
      const axes = Object.keys(range);
      if (axes.length) console.info('[ptz] steerable: ' + axes.join(', '), range);
      else console.info('[ptz] this camera has no pan/tilt/zoom controls, or Chrome was not granted them');
    },
  };
})();
