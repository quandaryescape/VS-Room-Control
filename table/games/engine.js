/* Shared harness for the table mini-games.
 *
 * A game is a small object registered with VSGames.register(). It gets an api
 * with a DOM layer, an optional retina-correct canvas, normalised pointer
 * input, a frame loop, and beep()/win()/lose(). The harness owns the lifecycle
 * so every game tears down cleanly when a Speed Trap interrupts it mid-round.
 */
(function () {
  'use strict';

  const registry = new Map();

  // One audio context for every game blip. Created lazily and resumed on the
  // first tap, because browsers won't let a page make noise unprompted.
  let actx = null;
  function audio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }

  function beep(freq, ms, type, gain) {
    const ac = audio();
    if (!ac) return;
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.type = type || 'square';
    osc.frequency.value = freq;
    amp.gain.value = 0;
    osc.connect(amp).connect(ac.destination);
    const t = ac.currentTime;
    const peak = gain === undefined ? 0.12 : gain;
    amp.gain.linearRampToValueAtTime(peak, t + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + (ms || 120) / 1000);
    osc.start(t);
    osc.stop(t + (ms || 120) / 1000 + 0.02);
  }

  // Every live instance, so one can never be silently orphaned. An orphan
  // keeps its timers, its frame loop and its beeps running forever, and its
  // win/lose hooks still fire into a UI that has moved on.
  const liveInstances = new Set();

  function create(id, host, hooks) {
    const def = registry.get(id);
    if (!def) throw new Error('unknown mini-game: ' + id);

    // Reusing a host means whatever was in it is finished, whether or not the
    // caller remembered to say so.
    for (const other of [...liveInstances]) {
      if (other.host === host) other.destroy();
    }

    host.innerHTML = '';
    const layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
    host.appendChild(layer);

    let finished = false;
    let rafId = null;
    const frameCbs = [];
    const timers = [];
    const listeners = [];

    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts || { passive: false });
      listeners.push([target, type, fn, opts]);
    }

    function pointFrom(ev) {
      const r = layer.getBoundingClientRect();
      const src = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
      return { x: src.clientX - r.left, y: src.clientY - r.top };
    }

    const api = {
      id,
      layer,
      w: layer.clientWidth,
      h: layer.clientHeight,
      dpr: Math.min(window.devicePixelRatio || 1, 2),
      beep,

      // Canvas games call this; DOM games just append to api.layer.
      makeCanvas() {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
        layer.appendChild(canvas);
        const g = canvas.getContext('2d');
        const fit = () => {
          api.w = layer.clientWidth;
          api.h = layer.clientHeight;
          canvas.width = Math.round(api.w * api.dpr);
          canvas.height = Math.round(api.h * api.dpr);
          g.setTransform(api.dpr, 0, 0, api.dpr, 0, 0);
        };
        fit();
        on(window, 'resize', fit);
        api.canvas = canvas;
        api.g = g;
        return { canvas, g };
      },

      el(tag, css, text) {
        const node = document.createElement(tag);
        if (css) node.style.cssText = css;
        if (text !== undefined) node.textContent = text;
        return node;
      },

      onFrame(cb) { frameCbs.push(cb); },

      onTap(cb) {
        on(layer, 'pointerdown', ev => { ev.preventDefault(); cb(pointFrom(ev), ev); });
      },

      onDrag(handlers) {
        let active = false;
        on(layer, 'pointerdown', ev => {
          ev.preventDefault(); active = true;
          if (layer.setPointerCapture) { try { layer.setPointerCapture(ev.pointerId); } catch (e) {} }
          handlers.start && handlers.start(pointFrom(ev), ev);
        });
        on(layer, 'pointermove', ev => { if (active) handlers.move && handlers.move(pointFrom(ev), ev); });
        const end = ev => { if (!active) return; active = false; handlers.end && handlers.end(pointFrom(ev), ev); };
        on(layer, 'pointerup', end);
        on(layer, 'pointercancel', end);
      },

      // Tap-left / tap-right / swipe, which is how the lane games are steered.
      onLane(cb) {
        let startX = 0, startY = 0, startT = 0;
        on(layer, 'pointerdown', ev => {
          ev.preventDefault();
          const p = pointFrom(ev);
          startX = p.x; startY = p.y; startT = Date.now();
        });
        on(layer, 'pointerup', ev => {
          const p = pointFrom(ev);
          const dx = p.x - startX;
          const dy = p.y - startY;
          if (Date.now() - startT < 500 && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
            cb(dx > 0 ? 1 : -1, 'swipe');
          } else {
            cb(p.x > api.w / 2 ? 1 : -1, 'tap');
          }
        });
      },

      after(ms, fn) { const t = setTimeout(fn, ms); timers.push(t); return t; },
      every(ms, fn) { const t = setInterval(fn, ms); timers.push(t); return t; },
      rand(a, b) { return a + Math.random() * (b - a); },
      randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); },

      progress(text) { hooks.onProgress && hooks.onProgress(text); },

      win() {
        if (finished) return;
        finished = true;
        beep(660, 90); setTimeout(() => beep(880, 160), 100);
        hooks.onWin && hooks.onWin();
      },

      lose(reason) {
        if (finished) return;
        finished = true;
        beep(180, 300, 'sawtooth');
        hooks.onLose && hooks.onLose(reason);
      },

      get finished() { return finished; },
    };

    // Frame loop with a delta clamped so a browser tab hiccup can't teleport
    // the player into an obstacle.
    let last = performance.now();
    function loop(now) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      api.w = layer.clientWidth;
      api.h = layer.clientHeight;
      for (const cb of frameCbs) {
        if (finished) break;
        cb(dt, now);
      }
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);

    audio();
    def.mount(api);

    const instance = {
      id,
      host,
      name: def.name,
      howto: def.howto,
      destroy() {
        liveInstances.delete(instance);
        finished = true;
        if (rafId) cancelAnimationFrame(rafId);
        for (const t of timers) { clearTimeout(t); clearInterval(t); }
        for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
        host.innerHTML = '';
      },
    };
    liveInstances.add(instance);
    return instance;
  }

  window.VSGames = {
    register(def) { registry.set(def.id, def); },
    live() { return liveInstances.size; },
    destroyAll() { for (const i of [...liveInstances]) i.destroy(); },
    get(id) { return registry.get(id) || null; },
    ids() { return [...registry.keys()]; },
    create,
    beep,
    audio,
  };
})();
