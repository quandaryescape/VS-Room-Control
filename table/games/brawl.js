/* Street Crew — a 1-4 player side-scrolling beat-'em-up on one table.
 *
 * The arcade-cabinet model: anyone can drop in at any moment by putting a
 * finger on a free control island, and anyone can walk away. The round is not
 * gated on a lobby, because a team standing around a table will not all press
 * "ready" at the same time and waiting for them wastes the clock.
 *
 * INPUT. Every player owns a control island along the bottom edge: a floating
 * stick on the left of the island and an attack pad on the right. Islands are
 * fixed positions rather than "wherever you touch", because four people
 * reaching over one table need to know where their own controls are without
 * looking down. This is the one game that needs api.onPointers - onTap and
 * onDrag collapse to a single pointer by design.
 *
 * SCALE. Enemy counts scale with the number of players who have actually
 * joined, and rescale mid-wave when someone drops in. One player fighting a
 * four-player wave is not a challenge, it is a loss, and a team that watches
 * one person lose learns nothing about the room.
 *
 * ART. Stick figures, drawn procedurally. No assets, scales to any table, and
 * the accent colour still comes from the room.
 */
VSGames.register({
  id: 'brawl',
  name: 'Street Crew',
  howto: 'Up to four players — put a finger on a free pad along the bottom to join. Left side of your pad moves, right side punches. Clear the street to win.',

  mount(api) {
    const { g } = api.makeCanvas();

    const MAX_PLAYERS = 4;
    const WAVES = 3;

    // Everything that decides how hard this is, on one screen. `normal` is
    // deliberately harder than the first cut of this game: five pips and a
    // four-tenths-of-a-second tell meant a crew could stand still, hold HIT
    // and win, which is not a fight.
    const PLAYER_HP = api.tune(6, 4, 3);
    const REVIVE_SECONDS = api.tune(3, 4, 5);
    const GOON_HP = api.tune(2, 2, 3);
    const BRUTE_HP = api.tune(6, 8, 11);
    const GOON_SPEED = api.tune(0.075, 0.098, 0.120);
    const BRUTE_SPEED = api.tune(0.050, 0.064, 0.078);
    // The wind-up is the whole defence: it is the window in which stepping off
    // the line saves you. Shortening it is what makes `hard` actually hard.
    const WIND_UP = api.tune(0.52, 0.38, 0.28);
    const SWING_GAP = api.tune([0.9, 1.6], [0.6, 1.2], [0.4, 0.85]);

    // The playfield is the top band; the bottom band is controls. Depth (z)
    // runs 0..1 across the walkable strip, which is what gives a beat-'em-up
    // its "step up and around him" feel.
    const padTop = () => api.h * 0.72;
    const floorTop = () => api.h * 0.30;
    const floorBot = () => api.h * 0.66;
    const zToY = z => floorTop() + z * (floorBot() - floorTop());
    const scaleAt = z => 0.78 + z * 0.34;

    const accent = () =>
      getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#f2a93b';

    const COLORS = ['#4ea3ff', '#35d07f', '#ff7bd5', '#ffd166'];

    let players = [];          // sparse, index 0..3
    let enemies = [];
    let hits = [];             // transient hit sparks
    // Shared credits, arcade style. Going down costs the crew one and you get
    // back up; running out ends the round. A per-player "you are dead" rule
    // reads fine with four people and is brutal with one - a solo player would
    // lose the instant their last pip went, making the revive timer decorative.
    // A joining player brings a credit with them, which is the coin slot.
    let lives = api.tune(3, 2, 1);
    let wave = 0;
    let waveClearedAt = 0;
    let spawning = false;
    let t = 0;
    let shake = 0;
    let joinPulse = 0;
    let over = false;

    for (let i = 0; i < MAX_PLAYERS; i++) players.push(null);

    function joinedCount() {
      return players.filter(Boolean).length;
    }

    function showProgress() {
      const n = joinedCount();
      api.progress(
        (n ? n + (n === 1 ? ' fighter' : ' fighters') : 'tap a pad to join') +
        '   ·   wave ' + Math.min(wave + 1, WAVES) + ' / ' + WAVES +
        '   ·   ' + lives + (lives === 1 ? ' credit' : ' credits')
      );
    }

    // ---- control islands -------------------------------------------------
    // Four equal slots along the bottom. Each is [stick half | attack half].
    function islandRect(i) {
      const pad = api.w * 0.012;
      const w = (api.w - pad * (MAX_PLAYERS + 1)) / MAX_PLAYERS;
      return {
        x: pad + i * (w + pad),
        y: padTop() + api.h * 0.02,
        w: w,
        h: api.h * 0.24,
      };
    }
    function stickCentre(i) {
      const r = islandRect(i);
      return { x: r.x + r.w * 0.27, y: r.y + r.h * 0.52, r: Math.min(r.w * 0.24, r.h * 0.34) };
    }
    function attackRect(i) {
      const r = islandRect(i);
      return { x: r.x + r.w * 0.56, y: r.y + r.h * 0.14, w: r.w * 0.38, h: r.h * 0.72 };
    }
    function inRect(p, r) {
      return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    }

    function makePlayer(i) {
      return {
        slot: i,
        color: COLORS[i],
        x: api.w * (0.22 + i * 0.08),
        z: 0.35 + i * 0.12,
        face: 1,
        hp: PLAYER_HP,
        down: 0,               // seconds left while KO'd
        attackT: 0,            // wind-down of the current swing
        cool: 0,
        hurt: 0,
        step: 0,               // walk-cycle phase
        stickId: null,
        attackId: null,
        move: { x: 0, z: 0 },
      };
    }

    api.onPointers({
      down(id, p) {
        for (let i = 0; i < MAX_PLAYERS; i++) {
          const island = islandRect(i);
          if (!inRect(p, island)) continue;

          // First touch on a free island joins. Arcade drop-in: no lobby, no
          // waiting for everyone to be ready.
          if (!players[i]) {
            players[i] = makePlayer(i);
            lives += 1;
            joinPulse = 0.6;
            api.beep(660, 90, 'triangle', 0.09);
            showProgress();
            rescaleWave();
          }
          const pl = players[i];
          if (inRect(p, attackRect(i))) {
            pl.attackId = id;
            swing(pl);
          } else {
            pl.stickId = id;
            pl.stickOrigin = { x: p.x, y: p.y };
            pl.move = { x: 0, z: 0 };
          }
          return;
        }
      },
      move(id, p) {
        for (const pl of players) {
          if (!pl || pl.stickId !== id) continue;
          const c = stickCentre(pl.slot);
          const dx = p.x - pl.stickOrigin.x;
          const dy = p.y - pl.stickOrigin.y;
          const len = Math.hypot(dx, dy) || 1;
          const cap = Math.min(len, c.r) / c.r;
          pl.move = { x: (dx / len) * cap, z: (dy / len) * cap };
          if (Math.abs(pl.move.x) > 0.25) pl.face = pl.move.x > 0 ? 1 : -1;
          return;
        }
      },
      up(id) {
        for (const pl of players) {
          if (!pl) continue;
          if (pl.stickId === id) { pl.stickId = null; pl.move = { x: 0, z: 0 }; }
          if (pl.attackId === id) pl.attackId = null;
        }
      },
    });

    // ---- combat ----------------------------------------------------------
    function swing(pl) {
      if (pl.down > 0 || pl.cool > 0 || over) return;
      pl.attackT = 0.22;
      pl.cool = 0.3;
      api.beep(300, 40, 'square', 0.05);

      const reach = api.w * 0.075;
      let landed = false;
      for (const e of enemies) {
        if (e.hp <= 0) continue;
        const dx = (e.x - pl.x) * pl.face;
        if (dx < -reach * 0.3 || dx > reach) continue;
        if (Math.abs(e.z - pl.z) > 0.14) continue;   // must be on the same line
        e.hp -= 1;
        e.stun = 0.28;
        e.knock = pl.face * api.w * 0.05;
        landed = true;
        hits.push({ x: e.x, y: zToY(e.z) - api.h * 0.06, life: 0.25, big: e.hp <= 0 });
        if (e.hp <= 0) {
          api.beep(140, 180, 'sawtooth', 0.07);
          shake = Math.min(1, shake + 0.35);
        } else {
          api.beep(520, 45, 'square', 0.06);
        }
      }
      if (landed) shake = Math.min(1, shake + 0.12);
    }

    function hurtPlayer(pl, from) {
      if (pl.down > 0 || pl.hurt > 0 || over) return;
      pl.hp -= 1;
      pl.hurt = 0.5;
      pl.x += Math.sign(pl.x - from) * api.w * 0.03;
      api.beep(200, 120, 'sawtooth', 0.08);
      shake = Math.min(1, shake + 0.3);
      if (pl.hp <= 0) {
        lives -= 1;
        pl.down = REVIVE_SECONDS;
        api.beep(120, 320, 'sawtooth', 0.09);
        showProgress();
        if (lives <= 0) {
          over = true;
          api.lose('the crew ran out of credits');
        }
      }
    }

    // ---- waves -----------------------------------------------------------
    function waveSize(index) {
      const n = Math.max(1, joinedCount());
      // Base difficulty per wave, then roughly one extra body per extra
      // player. A solo player gets a fight; four get a brawl.
      const base = api.tune([2, 3, 1], [3, 4, 1], [4, 5, 2])[index] || 3;
      // The brute wave scales more gently: brutes soak hits, so an extra one
      // adds far more time to a wave than an extra goon does, and the round
      // has a clock.
      const perPlayer = index === 2 ? api.tune(0.3, 0.5, 0.8) : api.tune(0.8, 1.1, 1.4);
      return Math.max(1, Math.round(base + (n - 1) * perPlayer));
    }

    function makeEnemy(kind) {
      const fromLeft = Math.random() < 0.5;
      return {
        kind,
        x: fromLeft ? -api.w * 0.08 : api.w * 1.08,
        z: api.rand(0.12, 0.9),
        hp: kind === 'brute' ? BRUTE_HP : GOON_HP,
        maxHp: kind === 'brute' ? BRUTE_HP : GOON_HP,
        speed: kind === 'brute' ? BRUTE_SPEED : GOON_SPEED,
        stun: 0,
        knock: 0,
        wind: 0,               // wind-up before a swing, so it can be dodged
        cool: api.rand(0.2, 1.2),
        step: Math.random() * 6,
        face: fromLeft ? 1 : -1,
      };
    }

    function startWave(index) {
      spawning = true;
      const kind = index === 2 ? 'brute' : 'goon';
      const count = waveSize(index);
      for (let i = 0; i < count; i++) {
        api.after(i * 280, () => { if (!api.finished && !over) enemies.push(makeEnemy(kind)); });
      }
      // The brute never comes alone; two goons keep the players moving.
      if (index === 2) {
        for (let i = 0; i < Math.max(1, joinedCount()); i++) {
          api.after(500 + i * 260, () => { if (!api.finished && !over) enemies.push(makeEnemy('goon')); });
        }
      }
      api.after(count * 280 + 400, () => { spawning = false; });
      showProgress();
    }

    // A player joining mid-wave should not trivialise the wave in progress.
    function rescaleWave() {
      if (over || spawning) return;
      const want = waveSize(wave);
      const alive = enemies.filter(e => e.hp > 0).length;
      // Reinforcements are always goons, even on the brute wave - a second
      // brute arriving because someone joined late is a punishment, not a
      // rebalance.
      for (let i = alive; i < want; i++) enemies.push(makeEnemy('goon'));
    }

    startWave(0);
    showProgress();

    // ---- simulation ------------------------------------------------------
    function stepPlayers(dt) {
      const speed = api.w * 0.30;
      for (const pl of players) {
        if (!pl) continue;

        pl.attackT = Math.max(0, pl.attackT - dt);
        pl.cool = Math.max(0, pl.cool - dt);
        pl.hurt = Math.max(0, pl.hurt - dt);

        if (pl.down > 0) {
          pl.down -= dt;
          if (pl.down <= 0) { pl.hp = PLAYER_HP; pl.hurt = 0.8; }
          continue;
        }

        // Holding the attack pad keeps swinging at the cooldown rate, which is
        // what people do anyway.
        if (pl.attackId !== null && pl.cool <= 0) swing(pl);

        const mx = pl.move.x;
        const mz = pl.move.z;
        if (Math.abs(mx) > 0.12 || Math.abs(mz) > 0.12) {
          pl.x += mx * speed * dt;
          pl.z += mz * dt * 0.9;
          pl.step += dt * 9;
        } else {
          pl.step = 0;
        }
        pl.x = Math.max(api.w * 0.03, Math.min(api.w * 0.97, pl.x));
        pl.z = Math.max(0.05, Math.min(0.95, pl.z));
      }
    }

    function stepEnemies(dt) {
      const live = players.filter(p => p && p.down <= 0);

      for (const e of enemies) {
        if (e.hp <= 0) continue;

        if (e.knock !== 0) {
          e.x += e.knock * dt * 6;
          e.knock *= 0.86;
          if (Math.abs(e.knock) < 1) e.knock = 0;
        }
        if (e.stun > 0) { e.stun -= dt; continue; }

        // Chase the nearest standing player. With nobody standing they mill
        // about rather than freeze, so the screen never looks broken.
        let target = null;
        let best = Infinity;
        for (const pl of live) {
          const d = Math.abs(pl.x - e.x) + Math.abs(pl.z - e.z) * api.w * 0.5;
          if (d < best) { best = d; target = pl; }
        }

        e.cool = Math.max(0, e.cool - dt);

        if (!target) {
          e.x += Math.sin(t * 0.8 + e.step) * api.w * 0.02 * dt;
          continue;
        }

        e.face = target.x >= e.x ? 1 : -1;
        const dz = target.z - e.z;
        const dx = target.x - e.x;
        const reach = api.w * 0.055;

        if (e.wind > 0) {
          e.wind -= dt;
          if (e.wind <= 0) {
            // The swing lands only if the player is still there. Stepping out
            // of the line during the wind-up is the whole defence.
            if (Math.abs(target.x - e.x) < reach * 1.25 && Math.abs(target.z - e.z) < 0.13) {
              hurtPlayer(target, e.x);
            }
            e.cool = api.rand(SWING_GAP[0], SWING_GAP[1]);
          }
          continue;
        }

        if (Math.abs(dx) < reach && Math.abs(dz) < 0.12) {
          if (e.cool <= 0) { e.wind = WIND_UP; api.beep(380, 60, 'triangle', 0.04); }
        } else {
          e.x += Math.sign(dx) * e.speed * api.w * dt;
          e.z += Math.sign(dz) * Math.min(Math.abs(dz), dt * 0.5);
          e.step += dt * 8;
        }
        e.z = Math.max(0.05, Math.min(0.95, e.z));
      }

      // Corpses linger for half a second so a kill is legible in a crowd.
      for (const e of enemies) {
        if (e.hp <= 0) e.fade = (e.fade === undefined ? 0.5 : e.fade) - dt;
      }
      enemies = enemies.filter(e => e.hp > 0 || e.fade > 0);
    }

    function checkRound() {
      if (over) return;

      // Nobody has picked up a pad yet. The round simply does not progress -
      // the server's clock is what ends it, not a loss the team never played.
      if (!joinedCount()) return;

      // Losing is handled where a credit is spent, in hurtPlayer. Everyone
      // being down at once is survivable as long as credits remain, which is
      // what makes a four-player wipe recoverable.
      if (spawning) return;
      if (enemies.some(e => e.hp > 0)) return;

      if (!waveClearedAt) waveClearedAt = t;
      if (t - waveClearedAt < 1.0) return;
      waveClearedAt = 0;

      wave++;
      if (wave >= WAVES) {
        over = true;
        return api.win();
      }
      api.beep(720, 120, 'triangle', 0.09);
      startWave(wave);
    }

    api.onFrame(dt => {
      t += dt;
      shake = Math.max(0, shake - dt * 3);
      joinPulse = Math.max(0, joinPulse - dt * 1.6);

      if (!over) {
        stepPlayers(dt);
        stepEnemies(dt);
        checkRound();
      }

      for (const h of hits) h.life -= dt;
      hits = hits.filter(h => h.life > 0);

      draw();
    });

    // ---- drawing ---------------------------------------------------------
    function draw() {
      const w = api.w;
      const h = api.h;
      const col = accent();

      g.save();
      if (shake > 0) g.translate(api.rand(-1, 1) * shake * 6, api.rand(-1, 1) * shake * 6);

      drawStreet(col);

      // Painter's algorithm: further up the screen is further away, so sorting
      // by z is what stops a fighter at the back being drawn over one in front.
      const cast = [];
      for (const pl of players) if (pl) cast.push({ z: pl.z, kind: 'p', ref: pl });
      for (const e of enemies) cast.push({ z: e.z, kind: 'e', ref: e });
      cast.sort((a, b) => a.z - b.z);
      for (const c of cast) {
        if (c.kind === 'p') drawFighter(c.ref, c.ref.color, true);
        else drawEnemy(c.ref);
      }

      for (const hit of hits) {
        const a = hit.life / 0.25;
        g.strokeStyle = 'rgba(255,255,255,' + a + ')';
        g.lineWidth = hit.big ? 5 : 3;
        const r = (hit.big ? 34 : 20) * (1.4 - a);
        g.beginPath();
        g.arc(hit.x, hit.y, r, 0, Math.PI * 2);
        g.stroke();
      }

      g.restore();
      drawControls(col);
    }

    function drawStreet(col) {
      const w = api.w;
      const h = api.h;

      const sky = g.createLinearGradient(0, 0, 0, padTop());
      sky.addColorStop(0, '#0a1220');
      sky.addColorStop(1, '#05070c');
      g.fillStyle = sky;
      g.fillRect(-20, -20, w + 40, padTop() + 20);

      // Skyline, seeded off nothing so it is stable frame to frame.
      g.fillStyle = '#0e1626';
      for (let i = 0; i < 14; i++) {
        const bw = w / 14;
        const bh = floorTop() * (0.35 + ((i * 37) % 11) / 18);
        g.fillRect(i * bw, floorTop() - bh, bw * 0.86, bh);
      }
      g.fillStyle = 'rgba(255,220,140,.5)';
      for (let i = 0; i < 40; i++) {
        const x = ((i * 97) % w);
        const y = floorTop() - ((i * 53) % Math.max(1, floorTop() * 0.7)) - 6;
        g.fillRect(x, y, 3, 4);
      }

      // Road.
      g.fillStyle = '#141a26';
      g.fillRect(0, floorTop(), w, floorBot() - floorTop());
      g.strokeStyle = 'rgba(255,255,255,.10)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, floorTop()); g.lineTo(w, floorTop()); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.06)';
      g.beginPath(); g.moveTo(0, floorBot()); g.lineTo(w, floorBot()); g.stroke();

      g.strokeStyle = 'rgba(255,255,255,.13)';
      g.lineWidth = 3;
      g.setLineDash([w * 0.045, w * 0.035]);
      g.beginPath();
      g.moveTo(0, (floorTop() + floorBot()) / 2);
      g.lineTo(w, (floorTop() + floorBot()) / 2);
      g.stroke();
      g.setLineDash([]);

      // Wave banner.
      g.fillStyle = 'rgba(255,255,255,.42)';
      g.font = '700 ' + Math.max(12, h * 0.026) + 'px "Cascadia Mono",Consolas,monospace';
      g.textAlign = 'center';
      const label = wave >= WAVES ? 'STREET CLEAR' :
        (wave === 2 ? 'WAVE 3 — BRUTE' : 'WAVE ' + (wave + 1));
      g.fillText(label, api.w / 2, floorTop() - h * 0.02);
      g.textAlign = 'left';
    }

    // A stick figure, posed from a handful of numbers. Everything is drawn
    // relative to `s` so a fighter at the back of the road is genuinely
    // smaller than one at the front.
    function drawFighter(o, colour, isPlayer) {
      const s = scaleAt(o.z) * api.h * 0.16;
      const x = o.x;
      const y = zToY(o.z);
      const swing = isPlayer ? o.attackT : 0;
      const wind = isPlayer ? 0 : (o.wind || 0);
      const bob = Math.sin(o.step) * s * 0.05;
      const face = o.face || 1;

      g.save();
      g.translate(x, y - bob);

      // Shadow first, on the ground rather than on the body.
      g.fillStyle = 'rgba(0,0,0,.42)';
      g.beginPath();
      g.ellipse(0, 0, s * 0.30, s * 0.09, 0, 0, Math.PI * 2);
      g.fill();

      const flash = (isPlayer && o.hurt > 0) || (!isPlayer && o.stun > 0);
      g.strokeStyle = flash ? '#ffffff' : colour;
      g.fillStyle = g.strokeStyle;
      g.lineWidth = Math.max(2.5, s * 0.085);
      g.lineCap = 'round';
      g.lineJoin = 'round';

      const hipY = -s * 0.52;
      const shoulderY = -s * 0.92;
      const headY = -s * 1.12;

      // Legs — a simple two-frame walk reads better than a smooth one at this
      // size, so the stride is driven straight off the step phase.
      const stride = Math.sin(o.step) * s * 0.22;
      g.beginPath();
      g.moveTo(0, hipY); g.lineTo(stride, 0);
      g.moveTo(0, hipY); g.lineTo(-stride, 0);
      g.stroke();

      // Spine.
      g.beginPath();
      g.moveTo(0, hipY); g.lineTo(0, shoulderY);
      g.stroke();

      // Arms. A swing throws the lead arm out along the facing; a wind-up
      // pulls it back, which is the tell players read to step away.
      const lead = swing > 0 ? s * 0.62 : (wind > 0 ? -s * 0.30 : s * 0.22);
      const leadY = swing > 0 ? shoulderY + s * 0.05 : shoulderY + s * 0.18;
      g.beginPath();
      g.moveTo(0, shoulderY); g.lineTo(face * lead, leadY);
      g.moveTo(0, shoulderY); g.lineTo(-face * s * 0.20, shoulderY + s * 0.24);
      g.stroke();

      // Head.
      g.beginPath();
      g.arc(0, headY, s * 0.17, 0, Math.PI * 2);
      g.stroke();

      g.restore();
    }

    function drawEnemy(e) {
      if (e.hp <= 0) {
        // Fold up rather than vanish, so a kill is legible in a crowd.
        const a = Math.max(0, (e.fade || 0) / 0.5);
        g.save();
        g.globalAlpha = a;
        g.strokeStyle = '#7d8698';
        g.lineWidth = 4;
        const s = scaleAt(e.z) * api.h * 0.16;
        g.beginPath();
        g.moveTo(e.x - s * 0.3, zToY(e.z));
        g.lineTo(e.x + s * 0.3, zToY(e.z) - s * 0.08);
        g.stroke();
        g.restore();
        return;
      }

      const colour = e.kind === 'brute' ? '#ff6b6b' : '#9aa6bd';
      drawFighter(e, colour, false);

      if (e.kind === 'brute') {
        const s = scaleAt(e.z) * api.h * 0.16;
        const w = s * 0.7;
        g.fillStyle = 'rgba(0,0,0,.6)';
        g.fillRect(e.x - w / 2, zToY(e.z) - s * 1.42, w, s * 0.08);
        g.fillStyle = '#ff6b6b';
        g.fillRect(e.x - w / 2, zToY(e.z) - s * 1.42, w * (e.hp / e.maxHp), s * 0.08);
      }
    }

    function drawControls(col) {
      const h = api.h;

      g.fillStyle = 'rgba(6,8,13,.92)';
      g.fillRect(0, padTop(), api.w, h - padTop());
      g.strokeStyle = 'rgba(255,255,255,.10)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, padTop()); g.lineTo(api.w, padTop()); g.stroke();

      for (let i = 0; i < MAX_PLAYERS; i++) {
        const r = islandRect(i);
        const pl = players[i];
        const c = stickCentre(i);
        const a = attackRect(i);

        g.strokeStyle = pl ? pl.color : 'rgba(255,255,255,.14)';
        g.lineWidth = 2;
        roundRect(r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.12);
        g.stroke();

        if (!pl) {
          const pulse = 0.5 + 0.5 * Math.sin(t * 3 + i);
          g.fillStyle = 'rgba(255,255,255,' + (0.30 + pulse * 0.35) + ')';
          g.font = '700 ' + Math.max(11, h * 0.022) + 'px "Cascadia Mono",Consolas,monospace';
          g.textAlign = 'center';
          g.fillText('TAP TO JOIN', r.x + r.w / 2, r.y + r.h * 0.55);
          g.fillStyle = 'rgba(255,255,255,.28)';
          g.font = '700 ' + Math.max(9, h * 0.016) + 'px "Cascadia Mono",Consolas,monospace';
          g.fillText('P' + (i + 1), r.x + r.w / 2, r.y + r.h * 0.82);
          g.textAlign = 'left';
          continue;
        }

        // Stick.
        g.strokeStyle = 'rgba(255,255,255,.18)';
        g.beginPath(); g.arc(c.x, c.y, c.r, 0, Math.PI * 2); g.stroke();
        g.fillStyle = pl.color;
        g.beginPath();
        g.arc(c.x + pl.move.x * c.r * 0.7, c.y + pl.move.z * c.r * 0.7, c.r * 0.38, 0, Math.PI * 2);
        g.fill();

        // Attack pad.
        g.fillStyle = pl.attackId !== null ? pl.color : 'rgba(255,255,255,.10)';
        roundRect(a.x, a.y, a.w, a.h, Math.min(a.w, a.h) * 0.2);
        g.fill();
        g.fillStyle = pl.attackId !== null ? '#06080d' : 'rgba(255,255,255,.6)';
        g.font = '800 ' + Math.max(11, h * 0.022) + 'px "Cascadia Mono",Consolas,monospace';
        g.textAlign = 'center';
        g.fillText('HIT', a.x + a.w / 2, a.y + a.h * 0.58);
        g.textAlign = 'left';

        // Health pips, or the revive countdown.
        const pipW = r.w * 0.09;
        for (let k = 0; k < PLAYER_HP; k++) {
          g.fillStyle = k < pl.hp ? pl.color : 'rgba(255,255,255,.13)';
          g.fillRect(r.x + r.w * 0.06 + k * (pipW + 3), r.y + r.h * 0.06, pipW, h * 0.010);
        }
        if (pl.down > 0) {
          g.fillStyle = 'rgba(6,8,13,.82)';
          roundRect(r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.12);
          g.fill();
          g.fillStyle = '#ff8080';
          g.font = '800 ' + Math.max(12, h * 0.028) + 'px "Cascadia Mono",Consolas,monospace';
          g.textAlign = 'center';
          g.fillText('DOWN ' + Math.ceil(pl.down), r.x + r.w / 2, r.y + r.h * 0.58);
          g.textAlign = 'left';
        }
      }

      if (joinPulse > 0) {
        g.fillStyle = 'rgba(255,255,255,' + (joinPulse * 0.10) + ')';
        g.fillRect(0, padTop(), api.w, api.h - padTop());
      }
    }

    function roundRect(x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.lineTo(x + w - r, y);
      g.quadraticCurveTo(x + w, y, x + w, y + r);
      g.lineTo(x + w, y + h - r);
      g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      g.lineTo(x + r, y + h);
      g.quadraticCurveTo(x, y + h, x, y + h - r);
      g.lineTo(x, y + r);
      g.quadraticCurveTo(x, y, x + r, y);
      g.closePath();
    }
  },
});
