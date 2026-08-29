/* Cut The Line — sever the ropes, drop the core into the collector.
 *
 * A Cut the Rope clone. The core hangs from one or more ropes; a swipe across
 * a rope cuts it; gravity and whatever swing has been built up do the rest.
 *
 * The core is a single verlet particle and each rope is a maximum-distance
 * constraint back to its anchor, rather than a chain of segments. A rope that
 * cannot stretch but can go slack is all the physics this needs, and it is
 * unconditionally stable — a segmented rope with a heavy mass on the end wants
 * far more solver iterations before it stops behaving like a spring, and "the
 * core exploded off the top of the screen" is not something anyone wants to
 * explain mid-game.
 *
 * Levels are hand-authored for the same reason flow.js bakes its boards in: an
 * unsolvable layout is not recoverable in front of customers, and unlike a grid
 * puzzle there is no cheap solver to verify a random physics one. Every layout
 * below puts the collector inside the arc the core can actually reach, and the
 * bumpers only deflect — none of them forms a pocket that can trap it.
 *
 * All art is procedural, so it scales from a 27-inch table to a 55-inch 4K one
 * and stays in the room's accent colour.
 */
VSGames.register({
  id: 'cutrope',
  name: 'Cut The Line',
  howto: 'Swipe across a rope to cut it and drop the core into the collector. Three deliveries wins — five drops and you lose.',

  mount(api) {
    const { g } = api.makeCanvas();

    const DELIVERIES_TO_WIN = api.tune(2, 3, 4);
    const MAX_DROPS = api.tune(7, 5, 3);
    const GRAVITY = 1500;

    // Normalised to the canvas, so one set of numbers fits every table size.
    const LEVELS = [
      // 1 — one rope, collector straight below. Teaches the swipe.
      {
        anchors: [{ x: 0.50, y: 0.16, len: 0.30 }],
        collector: { x: 0.50, w: 0.30 },
        bumpers: [],
      },
      // 2 — two ropes, collector off to the right. Cut one, let it swing, cut
      //     the other at the top of the arc.
      {
        anchors: [{ x: 0.32, y: 0.15, len: 0.32 }, { x: 0.68, y: 0.15, len: 0.32 }],
        collector: { x: 0.78, w: 0.24 },
        bumpers: [],
      },
      // 3 — mirrored, with a bumper that punishes dropping it straight down
      //     and hoping.
      {
        anchors: [{ x: 0.30, y: 0.14, len: 0.30 }, { x: 0.70, y: 0.14, len: 0.30 }],
        collector: { x: 0.22, w: 0.22 },
        bumpers: [{ x: 0.60, y: 0.62, r: 0.05 }],
      },
    ];

    let delivered = 0;
    let drops = 0;
    let levelIndex = 0;
    let ropes = [];
    let bumpers = [];
    let collector = { x: 0.5, w: 0.3 };
    let pos = { x: 0, y: 0 };
    let prev = { x: 0, y: 0 };
    let settling = false;      // level is over; brief pause before the next
    let sparks = [];
    let blade = [];            // recent swipe points, for the trail
    let flash = 0;
    let shake = 0;
    let t = 0;

    const accent = () =>
      getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#f2a93b';

    const coreR = () => Math.max(14, api.h * 0.033);
    const mouthTop = () => api.h * 0.84;
    const mouthX1 = () => (collector.x - collector.w / 2) * api.w;
    const mouthX2 = () => (collector.x + collector.w / 2) * api.w;

    function showProgress() {
      api.progress(delivered + ' / ' + DELIVERIES_TO_WIN +
        '   ·   ' + (MAX_DROPS - drops) + ' drops left');
    }

    function buildLevel() {
      const spec = LEVELS[levelIndex % LEVELS.length];
      collector = spec.collector;
      bumpers = spec.bumpers.map(b => ({ x: b.x, y: b.y, r: b.r, hit: 0 }));
      ropes = spec.anchors.map(a => ({ ax: a.x, ay: a.y, len: a.len, cut: false }));

      // Hang the core where the ropes agree it should be: under the midpoint
      // of the anchors, at the shortest rope's length.
      const ax = ropes.reduce((s, r) => s + r.ax, 0) / ropes.length;
      const ay = ropes.reduce((s, r) => s + r.ay, 0) / ropes.length;
      const len = Math.min.apply(null, ropes.map(r => r.len));
      pos = { x: ax * api.w, y: ay * api.h + len * api.h };
      prev = { x: pos.x, y: pos.y };

      settling = false;
      blade = [];
      showProgress();
    }

    buildLevel();

    // ---- cutting ---------------------------------------------------------
    // A swipe is a series of short segments. A rope is cut when one of those
    // segments crosses it, which is why this tests the segment the finger just
    // travelled rather than the point it is at now — at speed those points are
    // far apart and a point test misses the rope between them entirely.
    function segmentsCross(p1, p2, p3, p4) {
      const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
      if (Math.abs(d) < 1e-9) return false;
      const u = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
      const v = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
      return u >= 0 && u <= 1 && v >= 0 && v <= 1;
    }

    function trySlice(from, to) {
      if (settling) return;
      for (const rope of ropes) {
        if (rope.cut) continue;
        const anchor = { x: rope.ax * api.w, y: rope.ay * api.h };
        if (!segmentsCross(from, to, anchor, pos)) continue;

        rope.cut = true;
        api.beep(880, 60, 'triangle', 0.09);
        flash = 0.25;
        const mid = { x: (anchor.x + pos.x) / 2, y: (anchor.y + pos.y) / 2 };
        for (let i = 0; i < 14; i++) {
          sparks.push({
            x: mid.x, y: mid.y,
            vx: api.rand(-260, 260), vy: api.rand(-260, 120),
            life: api.rand(0.2, 0.5), max: 0.5, hot: true,
          });
        }
      }
    }

    let lastPoint = null;
    api.onDrag({
      start(p) { lastPoint = p; blade = [{ x: p.x, y: p.y, life: 0.3 }]; },
      move(p) {
        if (lastPoint) trySlice(lastPoint, p);
        lastPoint = p;
        blade.push({ x: p.x, y: p.y, life: 0.3 });
        if (blade.length > 24) blade.shift();
      },
      end() { lastPoint = null; },
    });

    // ---- physics ---------------------------------------------------------
    function step(dt) {
      // Verlet: velocity is implied by the gap between this position and the
      // last one, so a constraint that moves the core also changes its speed.
      const vx = (pos.x - prev.x) * 0.998;
      const vy = (pos.y - prev.y) * 0.998;
      prev.x = pos.x;
      prev.y = pos.y;
      pos.x += vx;
      pos.y += vy + GRAVITY * dt * dt;

      // Rope constraints, a few passes so two ropes settle against each other
      // rather than fighting.
      for (let pass = 0; pass < 6; pass++) {
        for (const rope of ropes) {
          if (rope.cut) continue;
          const ax = rope.ax * api.w;
          const ay = rope.ay * api.h;
          const len = rope.len * api.h;
          const dx = pos.x - ax;
          const dy = pos.y - ay;
          const dist = Math.hypot(dx, dy) || 0.0001;
          if (dist > len) {
            pos.x = ax + (dx / dist) * len;
            pos.y = ay + (dy / dist) * len;
          }
        }
      }

      // Bumpers deflect, they never hold. The sideways jitter stops the core
      // balancing on the exact top of one, which it can otherwise do for an
      // embarrassingly long time.
      const r = coreR();
      for (const b of bumpers) {
        const bx = b.x * api.w;
        const by = b.y * api.h;
        const br = b.r * api.h;
        const dx = pos.x - bx;
        const dy = pos.y - by;
        const dist = Math.hypot(dx, dy) || 0.0001;
        const min = br + r;
        if (dist >= min) continue;

        const nx = dx / dist;
        const ny = dy / dist;
        pos.x = bx + nx * min;
        pos.y = by + ny * min;
        prev.x = pos.x + nx * 3 + api.rand(-0.6, 0.6);
        prev.y = pos.y + ny * 3;
        b.hit = 0.3;
        shake = Math.min(1, shake + 0.25);
        api.beep(300, 50, 'square', 0.05);
      }

      // Side walls, so a hard swing cannot fling the core out sideways and rob
      // the player of a shot they had earned.
      if (pos.x < r) { pos.x = r; prev.x = pos.x + (pos.x - prev.x) * 0.5; }
      if (pos.x > api.w - r) { pos.x = api.w - r; prev.x = pos.x + (pos.x - prev.x) * 0.5; }
    }

    function levelOver(success) {
      if (settling) return;
      settling = true;

      if (success) {
        delivered++;
        flash = 0.5;
        api.beep(700, 90, 'triangle', 0.1);
        api.after(120, () => api.beep(940, 140, 'triangle', 0.1));
        for (let i = 0; i < 30; i++) {
          sparks.push({
            x: pos.x, y: mouthTop(),
            vx: api.rand(-200, 200), vy: api.rand(-420, -80),
            life: api.rand(0.3, 0.8), max: 0.8, hot: i % 2 === 0,
          });
        }
      } else {
        drops++;
        shake = 1;
        api.beep(200, 220, 'sawtooth', 0.09);
      }
      showProgress();

      if (delivered >= DELIVERIES_TO_WIN) return api.win();
      if (drops >= MAX_DROPS) return api.lose('dropped it five times');

      if (success) levelIndex++;
      api.after(success ? 800 : 600, () => { if (!api.finished) buildLevel(); });
    }

    api.onFrame(dt => {
      t += dt;
      flash = Math.max(0, flash - dt * 3);
      shake = Math.max(0, shake - dt * 3);

      if (!settling) {
        step(dt);
        const r = coreR();
        if (pos.x > mouthX1() && pos.x < mouthX2() && pos.y + r * 0.4 > mouthTop()) {
          levelOver(true);
        } else if (pos.y - r > api.h) {
          levelOver(false);
        }
      }

      for (const s of sparks) {
        s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 620 * dt; s.life -= dt;
      }
      sparks = sparks.filter(s => s.life > 0);
      for (const p of blade) p.life -= dt;
      blade = blade.filter(p => p.life > 0);
      for (const b of bumpers) b.hit = Math.max(0, b.hit - dt * 3);

      draw();
    });

    // ---- drawing ---------------------------------------------------------
    function draw() {
      const w = api.w;
      const h = api.h;
      const col = accent();

      g.save();
      if (shake > 0) g.translate(api.rand(-1, 1) * shake * 7, api.rand(-1, 1) * shake * 7);

      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#0b1018');
      sky.addColorStop(1, '#05070c');
      g.fillStyle = sky;
      g.fillRect(-20, -20, w + 40, h + 40);

      // Faint grid, so the swing reads against something.
      g.strokeStyle = 'rgba(255,255,255,.03)';
      g.lineWidth = 1;
      const cell = Math.max(48, h * 0.09);
      for (let x = 0; x < w; x += cell) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (let y = 0; y < h; y += cell) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }

      drawCollector(col);
      for (const b of bumpers) drawBumper(b);
      for (const rope of ropes) if (!rope.cut) drawRope(rope);
      drawCore(col);

      for (const s of sparks) {
        const a = Math.max(0, s.life / s.max);
        g.fillStyle = s.hot ? 'rgba(255,226,150,' + a + ')' : 'rgba(120,190,255,' + a + ')';
        g.fillRect(s.x - 2, s.y - 2, 4, 4);
      }

      if (blade.length > 1) {
        g.strokeStyle = 'rgba(255,255,255,.55)';
        g.lineWidth = 3;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(blade[0].x, blade[0].y);
        for (const p of blade) g.lineTo(p.x, p.y);
        g.stroke();
      }

      if (flash > 0) {
        g.fillStyle = 'rgba(255,255,255,' + (flash * 0.18) + ')';
        g.fillRect(-20, -20, w + 40, h + 40);
      }
      g.restore();
    }

    function drawRope(rope) {
      const ax = rope.ax * api.w;
      const ay = rope.ay * api.h;
      const len = rope.len * api.h;
      const dist = Math.hypot(pos.x - ax, pos.y - ay);

      // Slack rope sags; taut rope is a straight line under tension. Drawing
      // that difference is what makes the state readable at a glance.
      const slack = Math.max(0, len - dist);
      const mx = (ax + pos.x) / 2;
      const my = (ay + pos.y) / 2 + slack * 0.85;

      g.strokeStyle = 'rgba(214,224,240,.85)';
      g.lineWidth = Math.max(2, api.h * 0.005);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(ax, ay);
      g.quadraticCurveTo(mx, my, pos.x, pos.y);
      g.stroke();

      g.fillStyle = '#8794ad';
      g.beginPath();
      g.arc(ax, ay, Math.max(5, api.h * 0.012), 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#141a26';
      g.beginPath();
      g.arc(ax, ay, Math.max(2, api.h * 0.005), 0, Math.PI * 2);
      g.fill();
    }

    function drawCore(col) {
      const r = coreR();
      g.save();
      g.shadowColor = col;
      g.shadowBlur = r * 1.6;
      g.fillStyle = col;
      g.beginPath();
      g.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      g.fill();
      g.restore();

      g.fillStyle = 'rgba(10,12,18,.72)';
      g.beginPath();
      g.arc(pos.x, pos.y, r * 0.55, 0, Math.PI * 2);
      g.fill();

      g.strokeStyle = 'rgba(255,255,255,.5)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(pos.x, pos.y, r * 0.78, t * 2.2, t * 2.2 + Math.PI * 1.1);
      g.stroke();
    }

    function drawBumper(b) {
      const x = b.x * api.w;
      const y = b.y * api.h;
      const r = b.r * api.h;
      g.fillStyle = b.hit > 0 ? '#5b6a8c' : '#39445c';
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,.22)';
      g.lineWidth = 2;
      g.stroke();
    }

    function drawCollector(col) {
      const x1 = mouthX1();
      const x2 = mouthX2();
      const top = mouthTop();
      const h = api.h;
      const lip = h * 0.05;

      g.fillStyle = 'rgba(12,16,24,.95)';
      g.beginPath();
      g.moveTo(x1 - lip, top);
      g.lineTo(x2 + lip, top);
      g.lineTo(x2, h);
      g.lineTo(x1, h);
      g.closePath();
      g.fill();

      const glow = g.createLinearGradient(0, top, 0, h);
      glow.addColorStop(0, hexA(col, 0.55));
      glow.addColorStop(1, hexA(col, 0));
      g.fillStyle = glow;
      g.fillRect(x1, top, x2 - x1, h - top);

      g.strokeStyle = col;
      g.lineWidth = Math.max(3, h * 0.006);
      g.beginPath();
      g.moveTo(x1 - lip, top);
      g.lineTo(x2 + lip, top);
      g.stroke();

      // Intake ticks, drifting inward.
      g.strokeStyle = hexA(col, 0.5);
      g.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const p = (t * 0.5 + i / 5) % 1;
        const y = top + p * (h - top);
        const inset = p * (x2 - x1) * 0.22;
        g.beginPath();
        g.moveTo(x1 + inset, y);
        g.lineTo(x2 - inset, y);
        g.stroke();
      }
    }

    // The accent comes out of CSS as hex, and a canvas gradient needs alpha —
    // which there is no way to bolt onto a hex string.
    function hexA(hex, a) {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
      if (!m) return 'rgba(242,169,59,' + a + ')';
      const n = parseInt(m[1], 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
  },
});
