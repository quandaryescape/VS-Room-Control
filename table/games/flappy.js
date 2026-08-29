/* Flap Drone — tap to fly, thread the gates.
 *
 * All art is drawn procedurally: three parallax layers, animated rotors, a
 * thruster plume, glowing laser gates and a vignette. No image assets, so it
 * scales cleanly from a 27-inch table to a 55-inch 4K one and stays in the
 * room's accent colour.
 */
VSGames.register({
  id: 'flappy',
  name: 'Flap Drone',
  howto: 'Tap anywhere to flap. Fly through 8 gates without touching anything.',

  mount(api) {
    const { g } = api.makeCanvas();

    const TARGET = api.tune(6, 8, 11);
    const GRAVITY = 1900;
    const FLAP = -620;

    let y = api.h / 2;
    let vy = 0;
    let scrolled = 0;
    let passed = 0;
    let started = false;
    let gates = [];
    let sparks = [];
    let trail = [];
    let shake = 0;
    let flash = 0;
    let t = 0;

    // Parallax furniture, seeded once and scrolled forever.
    const far = Array.from({ length: 26 }, (_, i) => ({
      x: i * 190 + Math.random() * 80,
      w: 70 + Math.random() * 90,
      h: 0.22 + Math.random() * 0.36,
    }));
    const near = Array.from({ length: 18 }, (_, i) => ({
      x: i * 320 + Math.random() * 120,
      w: 110 + Math.random() * 130,
      h: 0.16 + Math.random() * 0.3,
      lights: Math.floor(2 + Math.random() * 4),
    }));

    const accent = () =>
      getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#f2a93b';

    const gateW = () => Math.max(52, api.w * 0.05);
    const gapH = () => Math.max(150, api.h * 0.31);
    const speed = () => Math.max(230, api.w * 0.22) + passed * 12;
    const droneX = () => api.w * 0.24;
    const droneR = () => Math.max(16, api.h * 0.035);

    function spawnGate(x) {
      const margin = api.h * 0.13;
      const gap = gapH();
      gates.push({ x, top: api.rand(margin, api.h - margin - gap), gap, scored: false });
    }

    (function seed() {
      const first = api.w * 0.95;
      const spacing = Math.max(300, api.w * 0.36);
      for (let i = 0; i < 4; i++) spawnGate(first + i * spacing);
    })();
    api.progress('0 / ' + TARGET);

    api.onTap(() => {
      started = true;
      vy = FLAP;
      api.beep(520, 55, 'square', 0.06);
      for (let i = 0; i < 10; i++) {
        sparks.push({
          x: droneX() - droneR() * 0.8, y,
          vx: api.rand(-260, -70), vy: api.rand(-120, 120),
          life: api.rand(0.25, 0.5), max: 0.5, hot: true,
        });
      }
    });

    api.onFrame(dt => {
      t += dt;
      shake = Math.max(0, shake - dt * 4);
      flash = Math.max(0, flash - dt * 3);

      if (started) {
        vy += GRAVITY * dt;
        y += vy * dt;
        scrolled += speed() * dt;
        for (const gate of gates) gate.x -= speed() * dt;

        const spacing = Math.max(300, api.w * 0.36);
        const last = gates[gates.length - 1];
        if (last && last.x < api.w - spacing) spawnGate(last.x + spacing);
        gates = gates.filter(gate => gate.x > -gateW() * 2);

        trail.push({ x: droneX(), y, life: 0.35 });

        const r = droneR();
        const dx = droneX();

        if (y - r < 0 || y + r > api.h) { boom(); return api.lose('crashed'); }

        for (const gate of gates) {
          const withinX = dx + r > gate.x && dx - r < gate.x + gateW();
          if (withinX && (y - r < gate.top || y + r > gate.top + gate.gap)) {
            boom();
            return api.lose('clipped a gate');
          }
          if (!gate.scored && gate.x + gateW() < dx - r) {
            gate.scored = true;
            passed++;
            flash = 0.35;
            api.beep(760, 70, 'triangle', 0.08);
            api.progress(passed + ' / ' + TARGET);
            if (passed >= TARGET) return api.win();
          }
        }
      }

      for (const s of sparks) {
        s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 300 * dt; s.life -= dt;
      }
      sparks = sparks.filter(s => s.life > 0);
      for (const p of trail) p.life -= dt;
      trail = trail.filter(p => p.life > 0);

      draw();
    });

    function boom() {
      shake = 1;
      for (let i = 0; i < 40; i++) {
        sparks.push({
          x: droneX(), y,
          vx: api.rand(-420, 420), vy: api.rand(-420, 420),
          life: api.rand(0.3, 0.8), max: 0.8, hot: i % 2 === 0,
        });
      }
    }

    function draw() {
      const w = api.w, h = api.h;
      const A = accent();

      g.save();
      if (shake > 0) {
        g.translate(api.rand(-1, 1) * shake * 14, api.rand(-1, 1) * shake * 14);
      }

      // ---- sky ----
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#0a1020');
      sky.addColorStop(0.45, '#12203a');
      sky.addColorStop(1, '#050810');
      g.fillStyle = sky;
      g.fillRect(-20, -20, w + 40, h + 40);

      // aurora wash, very slow
      const aur = g.createRadialGradient(w * 0.7, h * 0.1, 0, w * 0.7, h * 0.1, h * 0.9);
      aur.addColorStop(0, hexA(A, 0.1));
      aur.addColorStop(1, 'transparent');
      g.fillStyle = aur;
      g.fillRect(0, 0, w, h);

      // ---- stars ----
      g.fillStyle = 'rgba(255,255,255,.5)';
      for (let i = 0; i < 60; i++) {
        const sx = (i * 137.5 - scrolled * 0.04) % (w + 40) - 20;
        const sy = (i * 71.3) % (h * 0.6);
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.4 + i));
        g.globalAlpha = tw * 0.5;
        g.fillRect(sx, sy, 2, 2);
      }
      g.globalAlpha = 1;

      // ---- far skyline ----
      drawSkyline(far, 0.18, '#0e1526', h);
      // ---- near skyline with windows ----
      drawSkyline(near, 0.45, '#151f33', h, true);

      // ---- ground haze ----
      const haze = g.createLinearGradient(0, h * 0.75, 0, h);
      haze.addColorStop(0, 'transparent');
      haze.addColorStop(1, hexA(A, 0.13));
      g.fillStyle = haze;
      g.fillRect(0, h * 0.75, w, h * 0.25);

      // ---- gates ----
      const gw = gateW();
      for (const gate of gates) {
        drawGate(gate, gw, A, h);
      }

      // ---- trail ----
      for (const p of trail) {
        g.globalAlpha = (p.life / 0.35) * 0.35;
        g.fillStyle = A;
        const r = droneR() * 0.5 * (p.life / 0.35);
        g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;

      // ---- sparks ----
      for (const s of sparks) {
        g.globalAlpha = Math.max(s.life / (s.max || 0.5), 0);
        g.fillStyle = s.hot ? '#fff2cc' : A;
        g.fillRect(s.x, s.y, 4, 4);
      }
      g.globalAlpha = 1;

      if (!api.finished) drawDrone(A);

      // ---- vignette + scanlines ----
      const vig = g.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.95);
      vig.addColorStop(0, 'transparent');
      vig.addColorStop(1, 'rgba(0,0,0,.65)');
      g.fillStyle = vig;
      g.fillRect(0, 0, w, h);

      g.globalAlpha = 0.045;
      g.fillStyle = '#fff';
      for (let sy = 0; sy < h; sy += 4) g.fillRect(0, sy, w, 1);
      g.globalAlpha = 1;

      if (flash > 0) {
        g.fillStyle = hexA(A, flash * 0.25);
        g.fillRect(0, 0, w, h);
      }

      g.restore();

      if (!started) {
        g.fillStyle = 'rgba(238,242,248,.8)';
        g.font = '600 ' + Math.round(h * 0.045) + 'px "Segoe UI", system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText('TAP TO FLAP', w / 2, h * 0.82);
        g.font = Math.round(h * 0.028) + 'px "Segoe UI", system-ui, sans-serif';
        g.fillStyle = 'rgba(238,242,248,.4)';
        g.fillText('8 gates to earn a sabotage', w / 2, h * 0.88);
      }
    }

    function drawSkyline(list, parallax, colour, h, windows) {
      g.fillStyle = colour;
      for (const b of list) {
        const x = ((b.x - scrolled * parallax) % (api.w + 700)) - 350;
        const bh = h * b.h;
        g.fillRect(x, h - bh, b.w, bh);
        if (windows) {
          g.fillStyle = hexA(accent(), 0.28);
          for (let i = 0; i < (b.lights || 0); i++) {
            const wx = x + 12 + (i % 3) * (b.w / 3.4);
            const wy = h - bh + 16 + Math.floor(i / 3) * 26;
            if (wy < h - 8) g.fillRect(wx, wy, 8, 12);
          }
          g.fillStyle = colour;
        }
      }
    }

    function drawGate(gate, gw, A, h) {
      const x = gate.x;
      const topH = gate.top;
      const botY = gate.top + gate.gap;

      // pylons
      const grad = g.createLinearGradient(x, 0, x + gw, 0);
      grad.addColorStop(0, '#243149');
      grad.addColorStop(0.5, '#33445f');
      grad.addColorStop(1, '#1c2537');
      g.fillStyle = grad;
      g.fillRect(x, 0, gw, topH);
      g.fillRect(x, botY, gw, h - botY);

      // hazard stripes
      g.save();
      g.beginPath();
      g.rect(x, Math.max(0, topH - 26), gw, 26);
      g.rect(x, botY, gw, 26);
      g.clip();
      g.fillStyle = A;
      g.fillRect(x, topH - 26, gw, 26);
      g.fillRect(x, botY, gw, 26);
      g.fillStyle = 'rgba(0,0,0,.45)';
      for (let i = -30; i < gw + 30; i += 16) {
        g.beginPath();
        g.moveTo(x + i, topH - 26); g.lineTo(x + i + 8, topH - 26);
        g.lineTo(x + i - 4, topH); g.lineTo(x + i - 12, topH);
        g.closePath(); g.fill();
        g.beginPath();
        g.moveTo(x + i, botY); g.lineTo(x + i + 8, botY);
        g.lineTo(x + i - 4, botY + 26); g.lineTo(x + i - 12, botY + 26);
        g.closePath(); g.fill();
      }
      g.restore();

      // the beam across the gap, so the hazard reads instantly
      g.strokeStyle = hexA(A, gate.scored ? 0.12 : 0.4);
      g.lineWidth = 2;
      g.setLineDash([10, 12]);
      g.lineDashOffset = -t * 60;
      g.beginPath();
      g.moveTo(x + gw / 2, topH);
      g.lineTo(x + gw / 2, botY);
      g.stroke();
      g.setLineDash([]);

      // glow at the lips
      g.shadowColor = A;
      g.shadowBlur = 22;
      g.fillStyle = A;
      g.fillRect(x, topH - 4, gw, 4);
      g.fillRect(x, botY, gw, 4);
      g.shadowBlur = 0;
    }

    function drawDrone(A) {
      const r = droneR();
      const x = droneX();
      const tilt = Math.max(-0.5, Math.min(0.9, vy / 900));

      g.save();
      g.translate(x, y);
      g.rotate(tilt);

      // thruster plume
      const plume = 1 + Math.abs(Math.sin(t * 30)) * 0.3;
      const pg = g.createLinearGradient(-r * 1.1, 0, -r * 3 * plume, 0);
      pg.addColorStop(0, hexA(A, 0.9));
      pg.addColorStop(1, 'transparent');
      g.fillStyle = pg;
      g.beginPath();
      g.moveTo(-r * 0.9, -r * 0.34);
      g.lineTo(-r * 3 * plume, 0);
      g.lineTo(-r * 0.9, r * 0.34);
      g.closePath();
      g.fill();

      // body glow
      g.shadowColor = A;
      g.shadowBlur = 26;

      // hull
      const hull = g.createLinearGradient(0, -r, 0, r);
      hull.addColorStop(0, '#ffffff');
      hull.addColorStop(1, '#9fb0c8');
      g.fillStyle = hull;
      g.beginPath();
      g.ellipse(0, 0, r * 1.15, r * 0.82, 0, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;

      // canopy
      g.fillStyle = '#0b1220';
      g.beginPath();
      g.ellipse(r * 0.3, -r * 0.12, r * 0.4, r * 0.28, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = hexA(A, 0.7);
      g.beginPath();
      g.ellipse(r * 0.38, -r * 0.2, r * 0.16, r * 0.1, 0, 0, Math.PI * 2);
      g.fill();

      // rotor arms + spinning discs
      g.strokeStyle = '#8494ab';
      g.lineWidth = Math.max(2, r * 0.12);
      g.beginPath();
      g.moveTo(-r * 0.7, -r * 0.5); g.lineTo(-r * 1.3, -r * 0.95);
      g.moveTo(r * 0.7, -r * 0.5); g.lineTo(r * 1.3, -r * 0.95);
      g.stroke();

      for (const rx of [-r * 1.3, r * 1.3]) {
        const spin = Math.sin(t * 42 + (rx > 0 ? 1 : 0)) * r * 0.85;
        g.strokeStyle = hexA(A, 0.85);
        g.lineWidth = Math.max(2, r * 0.09);
        g.beginPath();
        g.moveTo(rx - spin, -r * 0.95);
        g.lineTo(rx + spin, -r * 0.95);
        g.stroke();
        g.fillStyle = '#c9d5e6';
        g.beginPath(); g.arc(rx, -r * 0.95, r * 0.13, 0, Math.PI * 2); g.fill();
      }

      g.restore();
    }

    // '#rrggbb' + alpha -> rgba()
    function hexA(hex, a) {
      const h = hex.replace('#', '');
      const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
      const n = parseInt(full, 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
  },
});
