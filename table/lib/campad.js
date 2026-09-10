/* Hold-to-steer buttons for a PTZ camera — shared by the tables and the
 * operator dashboard.
 *
 *   const pad = VSCamPad(root, { drive(vector) {}, home() {} });
 *
 * Any element inside `root` with data-pan, data-tilt or data-zoom (-1 or 1)
 * steers for as long as a finger or the mouse is held on it; data-home asks
 * for the home position. Several can be held at once — pan while zooming — and
 * the held set is summed into one velocity.
 *
 * While anything is held the velocity is re-sent every REPEAT_MS, because the
 * camera stops by itself when it hears nothing for half a second (a crashed
 * page or a lost release must not leave it grinding). Letting go sends a stop.
 */
(function () {
  'use strict';

  const REPEAT_MS = 150;
  const STEER = '[data-pan],[data-tilt],[data-zoom]';
  const AXES = ['pan', 'tilt', 'zoom'];

  window.VSCamPad = function (root, handlers) {
    const held = new Map();   // pointerId -> button
    let timer = null;

    function vector() {
      const v = { pan: 0, tilt: 0, zoom: 0 };
      for (const button of held.values()) {
        for (const axis of AXES) v[axis] += Number(button.dataset[axis] || 0);
      }
      for (const axis of AXES) v[axis] = Math.max(-1, Math.min(1, v[axis]));
      return v;
    }

    const send = () => handlers.drive(vector());

    function changed() {
      const pressed = new Set(held.values());
      for (const button of root.querySelectorAll(STEER)) {
        button.classList.toggle('held', pressed.has(button));
      }
      send();
      if (held.size && !timer) timer = setInterval(send, REPEAT_MS);
      if (!held.size && timer) { clearInterval(timer); timer = null; }
    }

    root.addEventListener('pointerdown', ev => {
      const button = ev.target.closest(STEER);
      if (!button || !root.contains(button) || button.disabled) return;
      ev.preventDefault();
      held.set(ev.pointerId, button);
      // Capture keeps the release coming here even if the finger slides off
      // the button, or a layer opens over it mid-press.
      try { button.setPointerCapture(ev.pointerId); } catch (e) {}
      changed();
    });

    const release = ev => { if (held.delete(ev.pointerId)) changed(); };
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);
    root.addEventListener('lostpointercapture', release);

    root.addEventListener('click', ev => {
      const button = ev.target.closest('[data-home]');
      if (button && root.contains(button) && !button.disabled) handlers.home();
    });

    // A long press on a touchscreen opens a context menu, which swallows the
    // release and leaves the button "held".
    root.addEventListener('contextmenu', ev => ev.preventDefault());

    return {
      // Let go of everything — before the pad is pointed at another camera.
      stop() {
        if (!held.size) return;
        held.clear();
        changed();
      },
    };
  };
})();
