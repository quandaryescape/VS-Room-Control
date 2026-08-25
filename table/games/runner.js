/* Corridor Run — three lanes, rushing tunnel, don't hit anything.
 *
 * Drawn as a real perspective corridor: floor and ceiling converge on a
 * vanishing point, wall panels and light strips stream past, and obstacles
 * scale up as they approach. The craft banks into lane changes rather than
 * snapping, which is what makes the steering feel responsive on a touchscreen.
 */
VSGames.register({
  id: 'runner',
  name: 'Corridor Run',
  howto: 'Tap the left or right half of the screen (or swipe) to change lanes. Survive 30 seconds.',

  mount(api) {
    const { g } = api.makeCanvas();

    const SURVIVE = 30;
    const LANES = 3;

    let lane = 1;
    let laneX = 1;          // eased, so lane changes read as a slide
    let bank = 0;           // roll angle while sliding
    let elapsed = 0;
    let distance = 0;
    let obstacles = [];
    let sparks = [];
    let spawnAt = 1.0;
    let shake = 0;
    let dead = false;
    let t = 0;

    const accent = () =>
      getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#f2a93b';

    const horizon = () => api.h * 0.34;
    const speed = () => 520 + elapsed * 16;

    // t = 0 at the vanishing point, 1 at the player's feet.
    function project(depth, laneIndex) {
      const hz = horizon();
      const e = depth * depth;
      const y = hz + (api.h - hz) * e;
      const spread = 0.05 + 0.95 * e;
      const laneOffset = (laneIndex - (LANES - 1) / 2) * (api.w * 0.27) * spread;
      return { x: api.w / 2 + laneOffset, y, scale: spread };
    }

    api.onLane(dir => {
      if (dead) return;
      const next = Math.max(0, Math.min(LANES - 1, lane + dir));
      if (next !== lane) { lane = next; api.beep(420, 45, 'square', 0.05); }
    });

    api.onFrame(dt => {
      t += dt;
      shake = Math.max(0, shake - dt * 4);
      if (dead) { drawAll(); return; }

      elapsed += dt;
      distance += speed() * dt;

      const prev = laneX;
      laneX += (lane - laneX) * Math.min(1, dt * 13);
      bank += (((laneX - prev) / Math.max(dt, 0.001)) * 0.06 - bank) * Math.min(1, dt * 8);

      api.progress(Math.max(0, Math.ceil(SURVIVE - elapsed)) + 's left');

      spawnAt -= dt;
      if (spawnAt <= 0) {
        // Never block every lane: always leave a way through.
        const blocked = new Set();
        const count = elapsed > 18 ? 2 : 1;
        while (blocked.size < count) blocked.add(api.randInt(0, LANES - 1));
        for (const l of blocked) obstacles.push({ d: 0, lane: l, seed: Math.random() });
        spawnAt = Math.max(0.42, 0.95 - elapsed * 0.016);
      }

      for (const ob of obstacles) ob.d += dt * (speed() / 900);
      obstacles = obstacles.filter(ob => ob.d < 1.3);

      for (const ob of obstacles) {
        if (ob.d > 0.88 && ob.d < 1.03 && Math.abs(ob.lane - laneX) < 0.45) {
          dead = true;
          shake = 1;
          for (let i = 0; i < 46; i++) {
            const p = project(0.98, laneX);
            sparks.push({
              x: p.x, y: p.y - 30,
              vx: api.rand(-500, 500), vy: api.rand(-560, 220),
              life: api.rand(0.3, 0.9), max: 0.9,
            });
          }
          return api.lose('hit an obstacle');
        }
      }

      for (const s of sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 900 * dt; s.life -= dt; }
      sparks = sparks.filter(s => s.life > 0);

      if (elapsed >= SURVIVE) return api.win();
      drawAll();
    });

    function drawAll() {
      const w = api.w, h = api.h, hz = horizon();
      const A = accent();

      g.save();
      if (shake > 0) g.translate(api.rand(-1, 1) * shake * 16, api.rand(-1, 1) * shake * 16);

      // ---- deep space at the vanishing point ----
      g.fillStyle = '#05070d';
      g.fillRect(-20, -20, w + 40, h + 40);

      const glow = g.createRadialGradient(w / 2, hz, 0, w / 2, hz, h * 0.7);
      glow.addColorStop(0, hexA(A, 0.28));
      glow.addColorStop(0.4, hexA(A, 0.05));
      glow.addColorStop(1, 'transparent');
      g.fillStyle = glow;
      g.fillRect(0, 0, w, h);

      // ---- ceiling and floor wedges ----
      const farL = project(0.02, -0.5), farR = project(0.02, LANES - 0.5);
      const nearL = project(1, -0.5), nearR = project(1, LANES - 0.5);

      const floorGrad = g.createLinearGradient(0, hz, 0, h);
      floorGrad.addColorStop(0, '#0b1322');
      floorGrad.addColorStop(1, '#161f33');
      g.fillStyle = floorGrad;
      g.beginPath();
      g.moveTo(farL.x, farL.y); g.lineTo(farR.x, farR.y);
      g.lineTo(nearR.x, h); g.lineTo(nearL.x, h);
      g.closePath(); g.fill();

      const ceilGrad = g.createLinearGradient(0, 0, 0, hz);
      ceilGrad.addColorStop(0, '#0d1425');
      ceilGrad.addColorStop(1, '#080d18');
      g.fillStyle = ceilGrad;
      g.beginPath();
      g.moveTo(farL.x, farL.y); g.lineTo(farR.x, farR.y);
      g.lineTo(nearR.x, 0); g.lineTo(nearL.x, 0);
      g.closePath(); g.fill();

      // ---- side walls ----
      g.fillStyle = '#0a1020';
      g.beginPath();
      g.moveTo(0, 0); g.lineTo(farL.x, farL.y); g.lineTo(nearL.x, h); g.lineTo(0, h);
      g.closePath(); g.fill();
      g.beginPath();
      g.moveTo(w, 0); g.lineTo(farR.x, farR.y); g.lineTo(nearR.x, h); g.lineTo(w, h);
      g.closePath(); g.fill();

      // ---- rushing rungs + wall light strips ----
      const RUNGS = 18;
      for (let i = 0; i < RUNGS; i++) {
        const d = ((i / RUNGS) + ((distance / 700) % (1 / RUNGS))) % 1;
        const l = project(d, -0.5);
        const r = project(d, LANES - 0.5);
        const a = d * d;

        g.strokeStyle = `rgba(130,165,215,${0.05 + a * 0.22})`;
        g.lineWidth = 1 + a * 2;
        g.beginPath(); g.moveTo(l.x, l.y); g.lineTo(r.x, r.y); g.stroke();

        // glowing panel light on each wall
        g.fillStyle = hexA(A, 0.06 + a * 0.5);
        const lh = 6 + a * 26;
        g.fillRect(l.x - (10 + a * 26), l.y - lh / 2, 10 + a * 26, lh);
        g.fillRect(r.x, r.y - lh / 2, 10 + a * 26, lh);
      }

      // ---- lane dividers ----
      for (let i = 0; i <= LANES; i++) {
        const edge = i - 0.5;
        const far = project(0.02, edge);
        const near = project(1, edge);
        g.strokeStyle = 'rgba(130,165,215,.2)';
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(far.x, far.y); g.lineTo(near.x, near.y); g.stroke();
      }

      // ---- obstacles, far to near ----
      for (const ob of [...obstacles].sort((a, b) => a.d - b.d)) {
        drawObstacle(ob, A);
      }

      // ---- sparks ----
      for (const s of sparks) {
        g.globalAlpha = Math.max(s.life / s.max, 0);
        g.fillStyle = s.life > 0.4 ? '#fff0d0' : A;
        g.fillRect(s.x, s.y, 5, 5);
      }
      g.globalAlpha = 1;

      if (!dead) drawCraft(A);

      // ---- speed streaks ----
      g.strokeStyle = hexA(A, 0.13);
      g.lineWidth = 2;
      for (let i = 0; i < 12; i++) {
        const d0 = ((i * 0.13) + ((distance / 400) % 0.13)) % 1;
        const side = i % 2 ? -0.62 : LANES - 0.38;
        const p0 = project(d0, side);
        const p1 = project(Math.min(d0 + 0.09, 1), side);
        g.globalAlpha = d0 * 0.5;
        g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
      }
      g.globalAlpha = 1;

      // ---- vignette ----
      const vig = g.createRadialGradient(w / 2, h * 0.55, h * 0.3, w / 2, h * 0.55, h);
      vig.addColorStop(0, 'transparent');
      vig.addColorStop(1, 'rgba(0,0,0,.72)');
      g.fillStyle = vig;
      g.fillRect(0, 0, w, h);

      g.restore();
    }

    function drawObstacle(ob, A) {
      const p = project(Math.min(ob.d, 1.25), ob.lane);
      const size = 96 * p.scale;
      const x = p.x, y = p.y;
      const alpha = Math.min(1, ob.d * 3);

      g.globalAlpha = alpha;

      // shadow pooled on the floor
      g.fillStyle = 'rgba(0,0,0,.5)';
      g.beginPath();
      g.ellipse(x, y + size * 0.04, size * 0.55, size * 0.12, 0, 0, Math.PI * 2);
      g.fill();

      // body
      const grad = g.createLinearGradient(x - size / 2, y - size, x + size / 2, y);
      grad.addColorStop(0, '#7a1420');
      grad.addColorStop(0.5, '#c9202f');
      grad.addColorStop(1, '#6d101c');
      g.fillStyle = grad;
      g.fillRect(x - size * 0.42, y - size * 0.92, size * 0.84, size * 0.92);

      // warning chevrons
      g.save();
      g.beginPath();
      g.rect(x - size * 0.42, y - size * 0.62, size * 0.84, size * 0.3);
      g.clip();
      g.fillStyle = '#f5d90a';
      g.fillRect(x - size * 0.42, y - size * 0.62, size * 0.84, size * 0.3);
      g.fillStyle = '#1a1206';
      const step = size * 0.18;
      for (let i = -2; i < 7; i++) {
        const ox = x - size * 0.5 + i * step + ((ob.seed * step) % step);
        g.beginPath();
        g.moveTo(ox, y - size * 0.62);
        g.lineTo(ox + step * 0.5, y - size * 0.62);
        g.lineTo(ox + step * 0.5 - size * 0.12, y - size * 0.32);
        g.lineTo(ox - size * 0.12, y - size * 0.32);
        g.closePath(); g.fill();
      }
      g.restore();

      // pulsing hazard lamp
      const pulse = 0.5 + 0.5 * Math.sin(t * 8 + ob.seed * 6);
      g.shadowColor = '#ff4d4d';
      g.shadowBlur = 26 * p.scale * pulse;
      g.fillStyle = `rgba(255,90,90,${0.5 + pulse * 0.5})`;
      g.fillRect(x - size * 0.42, y - size * 0.96, size * 0.84, size * 0.07);
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }

    function drawCraft(A) {
      const p = project(0.98, laneX);
      const size = 84 * p.scale;
      const x = p.x, y = p.y - size * 0.15;

      g.save();
      g.translate(x, y);
      g.rotate(Math.max(-0.4, Math.min(0.4, bank)));

      // engine glow on the floor
      const eg = g.createRadialGradient(0, size * 0.2, 0, 0, size * 0.2, size);
      eg.addColorStop(0, hexA(A, 0.55));
      eg.addColorStop(1, 'transparent');
      g.fillStyle = eg;
      g.beginPath(); g.ellipse(0, size * 0.2, size, size * 0.4, 0, 0, Math.PI * 2); g.fill();

      // twin thruster flames
      const flare = 0.7 + Math.abs(Math.sin(t * 26)) * 0.5;
      for (const ox of [-size * 0.26, size * 0.26]) {
        const fg = g.createLinearGradient(0, 0, 0, size * 0.75 * flare);
        fg.addColorStop(0, '#ffffff');
        fg.addColorStop(0.35, hexA(A, 0.95));
        fg.addColorStop(1, 'transparent');
        g.fillStyle = fg;
        g.beginPath();
        g.moveTo(ox - size * 0.1, 0);
        g.lineTo(ox + size * 0.1, 0);
        g.lineTo(ox, size * 0.75 * flare);
        g.closePath(); g.fill();
      }

      // hull
      g.shadowColor = A;
      g.shadowBlur = 22;
      const hull = g.createLinearGradient(0, -size, 0, size * 0.2);
      hull.addColorStop(0, '#ffffff');
      hull.addColorStop(0.6, '#cfdae9');
      hull.addColorStop(1, '#7d8ca3');
      g.fillStyle = hull;
      g.beginPath();
      g.moveTo(0, -size * 0.95);
      g.lineTo(size * 0.5, size * 0.05);
      g.lineTo(size * 0.2, size * 0.05);
      g.lineTo(0, -size * 0.2);
      g.lineTo(-size * 0.2, size * 0.05);
      g.lineTo(-size * 0.5, size * 0.05);
      g.closePath();
      g.fill();
      g.shadowBlur = 0;

      // cockpit + accent stripe
      g.fillStyle = '#0b1220';
      g.beginPath();
      g.ellipse(0, -size * 0.52, size * 0.13, size * 0.24, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = A;
      g.fillRect(-size * 0.5, -size * 0.02, size, size * 0.07);

      g.restore();
    }

    function hexA(hex, a) {
      const h = hex.replace('#', '');
      const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
      const n = parseInt(full, 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
  },
});
