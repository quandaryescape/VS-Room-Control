/* Scaffold — 1-2 players. One draws the level while the other climbs it.
 *
 * The jumper bounces by itself on every landing. Solo, the drawer alone decides
 * where it goes; a second player can take the jumper at any time and gets
 * steering and a charge jump.
 *
 * THE ANGLE IS THE GAME. A landing reflects off the drawn line's surface, so a
 * sloped platform throws the jumper sideways. That one rule is what makes the
 * drawer an aimer rather than a bricklayer, and it is why the solo mode works
 * at all - without it the answer to every board is "draw a staircase".
 *
 * INK is what stops the staircase literally. Drawing spends a budget in
 * proportion to line length and it refills over time, so the drawer has to
 * spend rather than stall.
 *
 * NO DEATH. Falling costs altitude and altitude costs time, which is pressure
 * enough for a 90-second round; the clock is the only way to lose. Ending a
 * round on one mistimed bounce would make the drawer's job feel punitive
 * rather than skilful.
 *
 * INPUT. api.onPointers only. api.onDrag binds its own pointerdown on the same
 * layer, so a game using both double-fires every touch - and two people on one
 * table need every finger routed by hand anyway: a drawer mid-stroke and a
 * jumper tapping must never steal each other's pointer.
 *
 * World coordinates are y-up: worldY 0 is the ground, larger is higher. Screen
 * y is flipped once, in worldToScreen. Doing it anywhere else is how sign
 * errors get in.
 */
VSGames.register({
  id: 'scaffold',
  name: 'Scaffold',
  howto: 'Draw platforms under the jumper to bounce it higher — the angle you draw steers it. Ink refills as you go. A second player can tap the bar at the bottom to take over the jumper.',

  mount(api) {
    const { g } = api.makeCanvas();

    // ---- tuning ----------------------------------------------------------
    const TARGET_ALTITUDE = api.tune(2200, 3200, 4400);   // world units to win
    const INK_MAX = api.tune(1500, 1100, 850);
    const INK_REGEN = api.tune(420, 320, 250);            // per second
    const GRAVITY = api.tune(1500, 1750, 2000);
    const MIN_BOUNCE = api.tune(760, 820, 860);           // floor on every bounce
    const RESTITUTION = 0.92;
    const MAX_VX = 520;
    const STEER_ACCEL = 900;
    const CHARGE_TIME = 0.55;                             // to a full meter
    const CHARGE_BOOST = 0.6;                             // +60% at full
    const MIN_STROKE = 26;                                // ignore stray taps

    // ---- layout ----------------------------------------------------------
    // The control bar is reserved from the start even in solo play. Growing it
    // when a second player joins would resize the field under a drawer who is
    // halfway through a stroke.
    const barTop = () => api.h * 0.82;
    const groundY = () => 0;                              // world y of the floor

    const accent = () =>
      getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#f2a93b';

    const jumperR = () => Math.max(11, api.h * 0.024);

    // ---- state -----------------------------------------------------------
    let camY = 0;                    // world y shown at the bottom of the field
    let best = 0;                    // highest world y reached
    let ink = INK_MAX;
    let platforms = [];              // { ax, ay, bx, by } in world coords
    let stroke = null;               // { id, pts: [{x,y}] } while drawing
    let jumper = { x: 0, y: 0, vx: 0, vy: 0 };
    let prevPos = { x: 0, y: 0 };
    let hasPilot = false;            // has a second player taken the jumper?
    let steerId = null;
    let chargeId = null;
    let steerDir = 0;
    let charge = 0;
    let landFlash = 0;
    let won = false;
    let t = 0;

    // ---- coordinate transforms -------------------------------------------
    // One place converts, so the y-flip cannot get applied twice.
    const fieldH = () => barTop();
    function worldToScreenY(wy) { return fieldH() - (wy - camY); }
    function screenToWorldY(sy) { return camY + (fieldH() - sy); }

    (function start() {
      jumper.x = api.w / 2;
      jumper.y = 120;
      jumper.vy = 0;
      prevPos = { x: jumper.x, y: jumper.y };
      // A floor to open on, so the first bounce does not depend on the drawer
      // getting a line down before the jumper has fallen off the bottom.
      platforms.push({ ax: api.w * 0.18, ay: 40, bx: api.w * 0.82, by: 40 });
      showProgress();
    })();

    function showProgress() {
      const pct = Math.min(100, Math.round((best / TARGET_ALTITUDE) * 100));
      api.progress(
        pct + '%   ·   ' + Math.round(best) + ' / ' + TARGET_ALTITUDE + 'm' +
        (hasPilot ? '   ·   2 players' : '')
      );
    }

    // ---- control bar hit areas -------------------------------------------
    function joinRect() {
      return { x: 0, y: barTop(), w: api.w, h: api.h - barTop() };
    }
    function steerRect() {
      const r = joinRect();
      return { x: r.x, y: r.y, w: r.w * 0.62, h: r.h };
    }
    function chargeRect() {
      const r = joinRect();
      return { x: r.x + r.w * 0.62, y: r.y, w: r.w * 0.38, h: r.h };
    }
    function inRect(p, r) {
      return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    }

    // ---- input -----------------------------------------------------------
    api.onPointers({
      down(id, p) {
        // Anything in the bar belongs to the jumper, anything above it to the
        // drawer. Routing on the way down is what keeps one role from
        // hijacking the other's finger.
        if (inRect(p, joinRect())) {
          if (!hasPilot) {
            hasPilot = true;
            api.beep(680, 90, 'triangle', 0.09);
            showProgress();
          }
          if (inRect(p, chargeRect())) {
            chargeId = id;
          } else {
            steerId = id;
            steerDir = p.x < steerRect().x + steerRect().w / 2 ? -1 : 1;
          }
          return;
        }
        if (ink <= 0) return;
        stroke = { id: id, pts: [{ x: p.x, y: screenToWorldY(p.y) }] };
      },

      move(id, p) {
        if (id === steerId) {
          steerDir = p.x < steerRect().x + steerRect().w / 2 ? -1 : 1;
          return;
        }
        if (!stroke || stroke.id !== id) return;

        const last = stroke.pts[stroke.pts.length - 1];
        const wy = screenToWorldY(p.y);
        const dx = p.x - last.x;
        const dy = wy - last.y;
        const len = Math.hypot(dx, dy);
        if (len < 6) return;                 // ignore jitter

        if (len > ink) {
          // Out of ink mid-stroke: lay down what is left and stop, rather than
          // silently dropping the rest of the line the drawer was aiming.
          const f = ink / len;
          stroke.pts.push({ x: last.x + dx * f, y: last.y + dy * f });
          ink = 0;
          commitStroke();
          return;
        }
        ink -= len;
        stroke.pts.push({ x: p.x, y: wy });
      },

      up(id) {
        if (id === steerId) { steerId = null; steerDir = 0; }
        if (id === chargeId) { chargeId = null; }
        if (stroke && stroke.id === id) commitStroke();
      },
    });

    // A stroke becomes a chain of straight platform segments. Keeping them as
    // segments rather than one polyline is what lets the bounce ask a simple
    // question - which segment did I cross - instead of solving a curve.
    function commitStroke() {
      if (!stroke) return;
      const pts = stroke.pts;
      stroke = null;
      if (pts.length < 2) return;

      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }
      if (total < MIN_STROKE) return;

      for (let i = 1; i < pts.length; i++) {
        platforms.push({
          ax: pts[i - 1].x, ay: pts[i - 1].y,
          bx: pts[i].x, by: pts[i].y,
        });
      }
      api.beep(430, 45, 'triangle', 0.05);
    }

    // ---- physics ---------------------------------------------------------
    function bounceOff(seg) {
      // Surface normal, forced to point upward: which end of the line was
      // drawn first must not decide which way the jumper leaves it.
      let nx = -(seg.by - seg.ay);
      let ny = seg.bx - seg.ax;
      const nlen = Math.hypot(nx, ny) || 1;
      nx /= nlen; ny /= nlen;
      if (ny < 0) { nx = -nx; ny = -ny; }

      // Reflect velocity about the normal.
      const dot = jumper.vx * nx + jumper.vy * ny;
      let vx = (jumper.vx - 2 * dot * nx) * RESTITUTION;
      let vy = (jumper.vy - 2 * dot * ny) * RESTITUTION;

      // Two clamps keep it playable. Every landing must make real upward
      // progress, or a shallow graze leaves the jumper dribbling in place; and
      // a steep line must not fire it across the screen faster than the drawer
      // can follow.
      const boost = 1 + CHARGE_BOOST * charge;
      if (vy < MIN_BOUNCE * boost) vy = MIN_BOUNCE * boost;
      vx = Math.max(-MAX_VX, Math.min(MAX_VX, vx));

      jumper.vx = vx;
      jumper.vy = vy;

      if (charge > 0.05) api.beep(880, 110, 'triangle', 0.09);
      else api.beep(560, 60, 'triangle', 0.06);
      charge = 0;
      landFlash = 0.3;
    }

    function step(dt) {
      prevPos.x = jumper.x;
      prevPos.y = jumper.y;

      if (hasPilot && steerDir !== 0) {
        jumper.vx += steerDir * STEER_ACCEL * dt;
        jumper.vx = Math.max(-MAX_VX, Math.min(MAX_VX, jumper.vx));
      }

      jumper.vy -= GRAVITY * dt;
      jumper.x += jumper.vx * dt;
      jumper.y += jumper.vy * dt;

      // Walls bounce rather than wrap. Wrapping makes the drawer's aim
      // meaningless the moment the jumper is near an edge.
      const r = jumperR();
      if (jumper.x < r) { jumper.x = r; jumper.vx = Math.abs(jumper.vx) * 0.8; }
      if (jumper.x > api.w - r) { jumper.x = api.w - r; jumper.vx = -Math.abs(jumper.vx) * 0.8; }

      // One-way platforms: only solid while falling, so a rising jumper passes
      // straight through whatever the drawer is building above it.
      if (jumper.vy < 0) {
        const from = { x: prevPos.x, y: prevPos.y - r };
        const to = { x: jumper.x, y: jumper.y - r };
        let landed = null;
        for (const seg of platforms) {
          const a = { x: seg.ax, y: seg.ay };
          const b = { x: seg.bx, y: seg.by };
          if (!api.segmentsCross(from, to, a, b)) continue;
          // With several crossings in one frame, take the highest - it is the
          // one the jumper reached first on the way down.
          if (!landed || Math.max(seg.ay, seg.by) > Math.max(landed.ay, landed.by)) {
            landed = seg;
          }
        }
        if (landed) bounceOff(landed);
      }

      // The floor is a backstop, not a fail state.
      if (jumper.y - r < groundY()) {
        jumper.y = groundY() + r;
        if (jumper.vy < 0) { jumper.vy = MIN_BOUNCE * 0.75; landFlash = 0.2; }
      }

      if (jumper.y > best) {
        best = jumper.y;
        showProgress();
      }

      // Camera follows both ways so the drawer can always see the jumper, but
      // never scrolls below the ground.
      const wantCam = Math.max(0, jumper.y - fieldH() * 0.45);
      camY += (wantCam - camY) * Math.min(1, dt * 4);

      // Drop platforms well below the view. "Well below" matters: cull too
      // eagerly and a jumper that falls arrives at an empty screen.
      const floor = camY - fieldH();
      platforms = platforms.filter(s => Math.max(s.ay, s.by) > floor);

      ink = Math.min(INK_MAX, ink + INK_REGEN * dt);

      if (chargeId !== null) charge = Math.min(1, charge + dt / CHARGE_TIME);

      if (!won && best >= TARGET_ALTITUDE) {
        won = true;
        api.win();
      }
    }

    api.onFrame(dt => {
      t += dt;
      landFlash = Math.max(0, landFlash - dt * 3);
      if (!won) step(dt);
      draw();
    });

    // ---- drawing ---------------------------------------------------------
    function draw() {
      const w = api.w;
      const col = accent();

      const sky = g.createLinearGradient(0, 0, 0, barTop());
      sky.addColorStop(0, '#070b14');
      sky.addColorStop(1, '#101828');
      g.fillStyle = sky;
      g.fillRect(0, 0, w, barTop());

      drawAltitudeLines();
      drawGround();
      drawPlatforms();
      drawStroke(col);
      drawJumper(col);
      drawTargetBand(col);

      // The field ends at the bar; nothing above it may bleed over.
      g.fillStyle = '#05070c';
      g.fillRect(0, barTop(), w, api.h - barTop());
      drawBar(col);
      drawInk(col);
    }

    function drawAltitudeLines() {
      const spacing = 400;
      const first = Math.floor(camY / spacing) * spacing;
      g.font = '600 ' + Math.max(9, api.h * 0.016) + 'px "Cascadia Mono",Consolas,monospace';
      for (let wy = first; wy < camY + fieldH() + spacing; wy += spacing) {
        const y = worldToScreenY(wy);
        if (y < 0 || y > barTop()) continue;
        g.strokeStyle = 'rgba(255,255,255,.05)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, y); g.lineTo(api.w, y); g.stroke();
        g.fillStyle = 'rgba(255,255,255,.16)';
        g.fillText(wy + 'm', 8, y - 5);
      }
    }

    function drawGround() {
      const y = worldToScreenY(groundY());
      if (y > barTop() || y < -40) return;
      g.fillStyle = '#0c1420';
      g.fillRect(0, y, api.w, barTop() - y);
      g.strokeStyle = 'rgba(255,255,255,.14)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, y); g.lineTo(api.w, y); g.stroke();
    }

    function drawTargetBand(col) {
      const y = worldToScreenY(TARGET_ALTITUDE);
      if (y < -20 || y > barTop()) return;
      g.strokeStyle = col;
      g.lineWidth = 3;
      g.setLineDash([14, 10]);
      g.beginPath(); g.moveTo(0, y); g.lineTo(api.w, y); g.stroke();
      g.setLineDash([]);
      g.fillStyle = col;
      g.font = '800 ' + Math.max(11, api.h * 0.022) + 'px "Cascadia Mono",Consolas,monospace';
      g.textAlign = 'center';
      g.fillText('TARGET', api.w / 2, y - 8);
      g.textAlign = 'left';
    }

    function drawPlatforms() {
      g.strokeStyle = 'rgba(214,224,240,.9)';
      g.lineWidth = Math.max(3, api.h * 0.007);
      g.lineCap = 'round';
      for (const s of platforms) {
        const y1 = worldToScreenY(s.ay);
        const y2 = worldToScreenY(s.by);
        if (Math.min(y1, y2) > barTop() || Math.max(y1, y2) < 0) continue;
        g.beginPath();
        g.moveTo(s.ax, y1);
        g.lineTo(s.bx, y2);
        g.stroke();
      }
    }

    function drawStroke(col) {
      if (!stroke || stroke.pts.length < 2) return;
      g.strokeStyle = col;
      g.lineWidth = Math.max(3, api.h * 0.007);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(stroke.pts[0].x, worldToScreenY(stroke.pts[0].y));
      for (const p of stroke.pts) g.lineTo(p.x, worldToScreenY(p.y));
      g.stroke();
    }

    function drawJumper(col) {
      const r = jumperR();
      const y = worldToScreenY(jumper.y);

      g.save();
      g.shadowColor = col;
      g.shadowBlur = r * (1.4 + landFlash * 2);
      g.fillStyle = col;
      g.beginPath();
      g.arc(jumper.x, y, r, 0, Math.PI * 2);
      g.fill();
      g.restore();

      // Eyes, so it reads as a character rather than a dot, and so the
      // direction it is travelling is legible at a glance.
      const look = Math.max(-1, Math.min(1, jumper.vx / MAX_VX));
      g.fillStyle = '#06080d';
      g.beginPath();
      g.arc(jumper.x + look * r * 0.28 - r * 0.22, y - r * 0.15, r * 0.16, 0, Math.PI * 2);
      g.arc(jumper.x + look * r * 0.28 + r * 0.22, y - r * 0.15, r * 0.16, 0, Math.PI * 2);
      g.fill();

      if (charge > 0.02) {
        g.strokeStyle = 'rgba(255,255,255,.8)';
        g.lineWidth = 3;
        g.beginPath();
        g.arc(jumper.x, y, r * 1.6, -Math.PI / 2, -Math.PI / 2 + charge * Math.PI * 2);
        g.stroke();
      }
    }

    function drawInk(col) {
      const w = api.w * 0.34;
      const h = Math.max(6, api.h * 0.012);
      const x = api.w - w - 14;
      const y = 14;
      g.fillStyle = 'rgba(255,255,255,.10)';
      g.fillRect(x, y, w, h);
      g.fillStyle = ink > INK_MAX * 0.15 ? col : '#ff6b6b';
      g.fillRect(x, y, w * (ink / INK_MAX), h);
      g.fillStyle = 'rgba(255,255,255,.45)';
      g.font = '700 ' + Math.max(9, api.h * 0.016) + 'px "Cascadia Mono",Consolas,monospace';
      g.textAlign = 'right';
      g.fillText('INK', x - 8, y + h);
      g.textAlign = 'left';
    }

    function drawBar(col) {
      const r = joinRect();
      g.strokeStyle = 'rgba(255,255,255,.10)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, r.y); g.lineTo(api.w, r.y); g.stroke();

      if (!hasPilot) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 3);
        g.fillStyle = 'rgba(255,255,255,' + (0.28 + pulse * 0.34) + ')';
        g.font = '700 ' + Math.max(12, api.h * 0.024) + 'px "Cascadia Mono",Consolas,monospace';
        g.textAlign = 'center';
        g.fillText('2ND PLAYER — TAP HERE TO TAKE THE JUMPER', api.w / 2, r.y + r.h * 0.58);
        g.textAlign = 'left';
        return;
      }

      const s = steerRect();
      const c = chargeRect();

      g.strokeStyle = 'rgba(255,255,255,.12)';
      g.beginPath(); g.moveTo(c.x, c.y); g.lineTo(c.x, c.y + c.h); g.stroke();

      // Steer pad: two halves, the held one lit.
      for (const side of [-1, 1]) {
        const half = { x: s.x + (side < 0 ? 0 : s.w / 2), y: s.y, w: s.w / 2, h: s.h };
        const lit = steerId !== null && steerDir === side;
        g.fillStyle = lit ? col : 'rgba(255,255,255,.06)';
        g.fillRect(half.x + 6, half.y + 8, half.w - 12, half.h - 16);
        g.fillStyle = lit ? '#06080d' : 'rgba(255,255,255,.5)';
        g.font = '800 ' + Math.max(14, api.h * 0.03) + 'px "Segoe UI",system-ui,sans-serif';
        g.textAlign = 'center';
        g.fillText(side < 0 ? '◀' : '▶', half.x + half.w / 2, half.y + half.h * 0.62);
      }

      g.fillStyle = chargeId !== null ? col : 'rgba(255,255,255,.06)';
      g.fillRect(c.x + 6, c.y + 8, c.w - 12, c.h - 16);
      g.fillStyle = chargeId !== null ? '#06080d' : 'rgba(255,255,255,.5)';
      g.font = '800 ' + Math.max(11, api.h * 0.022) + 'px "Cascadia Mono",Consolas,monospace';
      g.fillText('CHARGE', c.x + c.w / 2, c.y + c.h * 0.5);

      if (charge > 0) {
        g.fillStyle = 'rgba(255,255,255,.75)';
        g.fillRect(c.x + 6, c.y + c.h - 14, (c.w - 12) * charge, 5);
      }
      g.textAlign = 'left';
    }
  },
});
