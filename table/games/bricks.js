/* Brick Buster — a 1-4 player breakout on one table.
 *
 * DROP-IN, same as Street Crew: the bottom edge has four fixed join slots,
 * and a finger on a free one joins that player mid-round. No lobby — a crew standing
 * around a table will not all press "ready" together, and waiting burns clock.
 *
 * HOW IT SCALES, which is the whole design. The floor is divided between the
 * players who have actually joined, and a paddle is sized to a fixed fraction
 * of its own slice. Solo, one player owns the entire width and gets one very
 * wide paddle; four players own a quarter each and get quarter-sized paddles.
 * Total coverage is therefore the same at every player count, and so is the
 * difficulty - what changes is how far each person has to reach.
 *
 * The first cut of this sealed the floor under unjoined zones instead, so a
 * solo player defended a quarter and the rest bounced. That measured terribly:
 * a solo player who never moved their paddle at all still cleared 33 of 44
 * bricks in 25 seconds, because a ball trapped between three walls demolishes
 * the wall on its own. Skill has to matter, so the floor is always fully open
 * and always fully the players' problem.
 *
 * BRICKS DO NOT SCALE with the player count, deliberately — unlike Street
 * Crew's enemies. Joining a beat-'em-up mid-wave adds a fighter to a fight;
 * joining breakout and watching thirty new bricks appear reads as a punishment
 * for helping. More hands simply clears the same wall faster.
 *
 * CREDITS are shared and arcade-style: losing a ball costs the crew one, and a
 * joining player brings one with them.
 *
 * TUNNELLING is the one real trap in a brick game. A ball moving 700px/s at
 * 60fps travels ~12px per frame, and a brick is thinner than that at some
 * table sizes — so a naive step lets the ball pass straight through a wall it
 * should have hit. Movement is substepped to a fraction of the smallest brick
 * dimension instead. See moveBall().
 *
 * INPUT. api.onPointers only, like the other multi-player games: onTap and
 * onDrag collapse to a single pointer by design and would bind their own
 * handlers on the same layer.
 */
VSGames.register({
  id: 'bricks',
  name: 'Brick Buster',
  howto: 'Up to four players — put a finger on a free slot along the bottom to join. Slide to move your paddle. Clear every brick.',

  mount(api) {
    const { g } = api.makeCanvas();

    const MAX_PLAYERS = 4;
    const COLS = 10;
    const ROWS = 3;

    // Everything that sets the difficulty, on one screen.
    //
    // The wall is far smaller and the ball far faster than a coin-op breakout,
    // because this has to be WON inside a 90-second round, not played until
    // the player dies. Measured: 36 bricks at 0.80 left five standing after 90
    // seconds of perfectly-tracked four-player play, which is a loss. A round
    // that cannot be won by good play is not a gate, it is a wall.
    const BALL_SPEED = api.tune(0.85, 1.05, 1.28);   // fraction of table height per second
    // Applied as cleared * SPEED_RAMP, so a full wall adds roughly +0.2 by the
    // end. (It was previously scaled by a stray 0.01 and moved the ball by
    // about 3% over an entire round - the ramp existed only on paper.)
    const SPEED_RAMP = api.tune(0.004, 0.007, 0.010);
    // Share of its OWN slice of floor that a paddle covers - not of the table.
    // That is what keeps one player and four players equally hard.
    const PADDLE_COVER = api.tune(0.52, 0.42, 0.34);
    const POWER_CHANCE = api.tune(0.22, 0.15, 0.09);
    const START_CREDITS = api.tune(4, 3, 2);

    const COLORS = ['#4ea3ff', '#35d07f', '#ff7bd5', '#ffd166'];
    const accent = () =>
      getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#f2a93b';

    // ---- layout (all derived, so a resize is free) -----------------------
    const bandTop = () => api.h * 0.76;   // control band: where fingers live
    const floorY = () => api.h * 0.70;    // past this the ball is lost
    const paddleY = () => api.h * 0.655;
    const fieldX0 = () => api.w * 0.05;
    const fieldX1 = () => api.w * 0.95;
    const fieldY0 = () => api.h * 0.08;
    const ballR = () => Math.max(6, Math.min(api.w, api.h) * 0.013);

    // Join slots are fixed along the band so a player always knows where their
    // own control is (the lesson from Street Crew's islands). The stretch of
    // FLOOR they defend is separate, and is re-divided between whoever has
    // joined - see relayout().
    const slotX0 = i => (api.w / MAX_PLAYERS) * i;
    const slotX1 = i => (api.w / MAX_PLAYERS) * (i + 1);

    let players = new Array(MAX_PLAYERS).fill(null);
    let roster = [];                  // joined players, left to right
    const pointerOwner = new Map();   // pointerId -> player index
    let bricks = [];
    let balls = [];
    let powerups = [];
    let sparks = [];
    let credits = START_CREDITS;
    let cleared = 0;
    let slowUntil = 0;
    let launchAt = 0;
    let shake = 0;
    let t = 0;
    let over = false;

    // ---- bricks -----------------------------------------------------------
    // A brick stores only WHICH brick it is; where it sits on screen is derived
    // from the current canvas size by layoutWall(). Positioning them once at
    // mount looked fine and was not: every other measurement here (paddle,
    // floor, ball radius) is recomputed per frame, so if the wall was built
    // before layout settled — or the table were ever resized — the bricks stayed
    // at the old coordinates while the ball played by the new ones. Measured
    // symptom: a full 90-second round in which the ball never touched a brick.
    function buildWall() {
      bricks = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          bricks.push({
            row: r, col: c,
            hp: r === 0 ? 2 : 1,
            maxHp: r === 0 ? 2 : 1,
            alive: true,
            flash: 0,
            x: 0, y: 0, w: 0, h: 0,
          });
        }
      }
    }

    let laidOutW = 0, laidOutH = 0;
    function layoutWall(force) {
      if (!force && api.w === laidOutW && api.h === laidOutH) return;
      laidOutW = api.w; laidOutH = api.h;
      const w = fieldX1() - fieldX0();
      const gap = w * 0.008;
      const bw = (w - gap * (COLS - 1)) / COLS;
      const bh = api.h * 0.042;
      for (const b of bricks) {
        b.x = fieldX0() + b.col * (bw + gap);
        b.y = fieldY0() + b.row * (bh + gap);
        b.w = bw;
        b.h = bh;
      }
    }

    buildWall();
    layoutWall(true);

    const aliveBricks = () => bricks.filter(b => b.alive).length;
    const joinedCount = () => players.filter(Boolean).length;

    function showProgress() {
      const n = joinedCount();
      api.progress(
        (n ? n + (n === 1 ? ' player' : ' players') : 'touch the bottom to join') +
        '   ·   ' + aliveBricks() + ' bricks' +
        '   ·   ' + credits + (credits === 1 ? ' credit' : ' credits')
      );
    }
    showProgress();

    // ---- players ----------------------------------------------------------
    function makePlayer(i) {
      const mid = (slotX0(i) + slotX1(i)) / 2;
      return { i, k: 0, n: 1, x: mid, target: mid, wideUntil: 0, joinPulse: 0.7, hits: 0 };
    }

    // Re-divide the floor. Called whenever someone joins: with N players the
    // floor is N equal slices, handed out left to right in slot order.
    function relayout() {
      roster = players.filter(Boolean).sort((a, b) => a.i - b.i);
      roster.forEach((p, k) => { p.k = k; p.n = roster.length; });
      for (const p of roster) clampPaddle(p);
    }

    const zoneWidth = p => api.w / p.n;
    const zoneLo = p => zoneWidth(p) * p.k;
    const zoneHi = p => zoneWidth(p) * (p.k + 1);

    function paddleHalf(p) {
      const base = zoneWidth(p) * PADDLE_COVER / 2;
      return t < p.wideUntil ? base * 1.4 : base;
    }

    // A paddle stays inside its own slice, so four players cannot all bunch
    // over the ball and leave three quarters of the floor unguarded.
    function clampPaddle(p) {
      const half = paddleHalf(p);
      const lo = zoneLo(p) + half;
      const hi = zoneHi(p) - half;
      p.x = hi < lo ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, p.x));
    }

    // Which player is responsible for the floor under x.
    function guardAt(x) {
      if (!roster.length) return null;
      const k = Math.max(0, Math.min(roster.length - 1,
        Math.floor(x / (api.w / roster.length))));
      return roster[k];
    }

    const slotAt = x =>
      Math.max(0, Math.min(MAX_PLAYERS - 1, Math.floor(x / (api.w / MAX_PLAYERS))));

    api.onPointers({
      down(id, p) {
        if (over) return;
        if (p.y < floorY()) return;              // taps in the play area do nothing
        const i = slotAt(p.x);
        if (!players[i]) {
          players[i] = makePlayer(i);
          credits += 1;                          // the coin slot
          relayout();
          api.beep(660, 90, 'triangle', 0.09);
          showProgress();
          if (!balls.length && !launchAt) launchAt = t + 1.1;
        }
        pointerOwner.set(id, i);
        players[i].target = p.x;
      },
      move(id, p) {
        const i = pointerOwner.get(id);
        if (i === undefined || !players[i]) return;
        players[i].target = p.x;
      },
      up(id) {
        pointerOwner.delete(id);                 // paddle simply stops where it is
      },
    });

    // ---- balls ------------------------------------------------------------
    function speedNow() {
      const base = api.h * (BALL_SPEED + cleared * SPEED_RAMP);
      return t < slowUntil ? base * 0.68 : base;
    }

    function spawnBall() {
      if (!roster.length) return;
      const p = roster[Math.floor(Math.random() * roster.length)];
      balls.push({ x: p.x, y: paddleY() - ballR() * 1.4, vx: 0, vy: 0, stuck: p.i, trail: [] });
      launchAt = t + 0.9;
    }

    function launchAll() {
      for (const b of balls) {
        if (b.stuck === null || b.stuck === undefined) continue;
        const ang = -Math.PI / 2 + api.rand(-0.5, 0.5);
        const s = speedNow();
        b.vx = Math.cos(ang) * s;
        b.vy = Math.sin(ang) * s;
        b.stuck = null;
      }
      api.beep(520, 70, 'square', 0.07);
    }

    function loseBall(b) {
      balls = balls.filter(o => o !== b);
      if (balls.length) return;                  // other balls still in play
      credits -= 1;
      shake = 1;
      api.beep(150, 320, 'sawtooth', 0.14);
      showProgress();
      if (credits <= 0) { over = true; return api.lose('ran out of credits'); }
      spawnBall();
    }

    // ---- collisions -------------------------------------------------------
    function hitBrick(b, brick) {
      brick.hp--;
      brick.flash = 1;
      cleared++;
      api.beep(300 + brick.row * 90 + (2 - brick.hp) * 40, 45, 'square', 0.06);

      for (let i = 0; i < (brick.hp <= 0 ? 8 : 3); i++) {
        sparks.push({
          x: brick.x + brick.w / 2, y: brick.y + brick.h / 2,
          vx: api.rand(-180, 180), vy: api.rand(-180, 120),
          life: api.rand(0.2, 0.5), max: 0.5, row: brick.row,
        });
      }

      if (brick.hp <= 0) {
        brick.alive = false;
        if (Math.random() < POWER_CHANCE) dropPower(brick);
        showProgress();
        if (!aliveBricks()) { over = true; api.win(); }
      }
    }

    // Move one ball with substepping, so a fast ball cannot pass through a
    // brick thinner than its per-frame travel.
    function moveBall(b, dt) {
      if (b.stuck !== null && b.stuck !== undefined) {
        const p = players[b.stuck];
        if (p) { b.x = p.x; b.y = paddleY() - ballR() * 1.4; }
        return;
      }

      const r = ballR();
      const dist = Math.hypot(b.vx, b.vy) * dt;
      const smallest = Math.min(
        bricks.length ? bricks[0].h : r * 2,
        bricks.length ? bricks[0].w : r * 2
      );
      const steps = Math.max(1, Math.ceil(dist / Math.max(4, smallest * 0.4)));
      const sdt = dt / steps;

      for (let s = 0; s < steps && !over; s++) {
        b.x += b.vx * sdt;
        b.y += b.vy * sdt;

        // side and top walls
        if (b.x - r < 0) { b.x = r; b.vx = Math.abs(b.vx); api.beep(420, 30, 'square', 0.04); }
        if (b.x + r > api.w) { b.x = api.w - r; b.vx = -Math.abs(b.vx); api.beep(420, 30, 'square', 0.04); }
        if (b.y - r < 0) { b.y = r; b.vy = Math.abs(b.vy); api.beep(420, 30, 'square', 0.04); }

        // paddles
        if (b.vy > 0) {
          const py = paddleY();
          const ph = api.h * 0.018;
          if (b.y + r >= py && b.y + r <= py + ph + Math.abs(b.vy * sdt)) {
            const p = guardAt(b.x);
            if (p) {
              const half = paddleHalf(p);
              if (b.x >= p.x - half - r * 0.5 && b.x <= p.x + half + r * 0.5) {
                // Where it lands on the paddle sets the angle — the whole
                // skill of breakout is aiming with the edges.
                const off = Math.max(-1, Math.min(1, (b.x - p.x) / half));
                let ang = -Math.PI / 2 + off * 1.05;

                // Keep the angle out of BOTH degenerate cases. Too flat is an
                // endless horizontal rally; too vertical is worse, and is not
                // hypothetical - a player (or a paddle centred under the ball)
                // returning it straight up sends it back down the same column,
                // and once that column is empty the ball bounces between floor
                // and ceiling forever, hitting nothing. Measured before this
                // clamp: a perfectly-tracked solo game cleared 7 bricks in 90
                // seconds and timed out.
                // Endgame assist. Once the wall is nearly down, finding the
                // last brick is luck rather than skill: measured, a
                // two-player game ran the full 90 seconds out with exactly
                // ONE brick standing. On the last few the paddle aims for
                // you, which reads as the ball finally finding it.
                const left = aliveBricks();
                let aiming = false;
                if (left <= 3) {
                  let best = null, bestD = Infinity;
                  for (const br of bricks) {
                    if (!br.alive) continue;
                    const d = Math.abs((br.x + br.w / 2) - b.x);
                    if (d < bestD) { bestD = d; best = br; }
                  }
                  if (best) {
                    const want = Math.atan2(
                      (best.y + best.h / 2) - b.y,
                      (best.x + best.w / 2) - b.x
                    );
                    const blend = left === 1 ? 0.8 : 0.5;
                    ang = ang * (1 - blend) + want * blend;
                    aiming = true;
                  }
                }

                // Keep it off the vertical - but not while aiming, because a
                // last brick straight overhead wants exactly that shot.
                const MIN_TILT = 0.24;   // radians away from straight up
                const drift = off !== 0 ? Math.sign(off)
                  : (b.vx !== 0 ? Math.sign(b.vx) : (Math.random() < 0.5 ? -1 : 1));
                if (!aiming && Math.abs(ang + Math.PI / 2) < MIN_TILT) {
                  ang = -Math.PI / 2 + drift * MIN_TILT;
                }

                const sp = speedNow();
                b.vx = Math.cos(ang) * sp;
                b.vy = Math.sin(ang) * sp;
                if (Math.abs(b.vy) < sp * 0.35) b.vy = -sp * 0.35;
                b.y = py - r;
                p.hits++;
                api.beep(520 + off * 90, 40, 'triangle', 0.07);
                continue;
              }
            }
          }
        }

        // out of play
        if (b.y - r > floorY()) { loseBall(b); return; }

        // bricks
        for (const brick of bricks) {
          if (!brick.alive) continue;
          if (b.x + r < brick.x || b.x - r > brick.x + brick.w) continue;
          if (b.y + r < brick.y || b.y - r > brick.y + brick.h) continue;

          // Reflect off whichever face we entered through: compare how far the
          // ball has penetrated horizontally vs vertically.
          const cx = brick.x + brick.w / 2;
          const cy = brick.y + brick.h / 2;
          const ox = (brick.w / 2 + r) - Math.abs(b.x - cx);
          const oy = (brick.h / 2 + r) - Math.abs(b.y - cy);
          if (ox < oy) {
            b.vx = b.x < cx ? -Math.abs(b.vx) : Math.abs(b.vx);
            b.x += b.x < cx ? -ox : ox;
          } else {
            b.vy = b.y < cy ? -Math.abs(b.vy) : Math.abs(b.vy);
            b.y += b.y < cy ? -oy : oy;
          }
          hitBrick(b, brick);
          break;
        }
      }

      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 9) b.trail.shift();
    }

    // ---- power-ups --------------------------------------------------------
    const POWERS = [
      { id: 'wide',  label: 'WIDE',  color: '#35d07f' },
      { id: 'slow',  label: 'SLOW',  color: '#4ea3ff' },
      { id: 'multi', label: 'MULTI', color: '#ff7bd5' },
      { id: 'life',  label: '+1',    color: '#ffd166' },
    ];

    function dropPower(brick) {
      const kind = POWERS[Math.floor(Math.random() * POWERS.length)];
      powerups.push({
        x: brick.x + brick.w / 2, y: brick.y + brick.h / 2,
        kind, spin: 0,
      });
    }

    function collectPower(pu, p) {
      api.beep(780, 130, 'triangle', 0.1);
      if (pu.kind.id === 'wide') { p.wideUntil = t + 12; clampPaddle(p); }
      else if (pu.kind.id === 'slow') slowUntil = t + 8;
      else if (pu.kind.id === 'life') { credits += 1; showProgress(); }
      else if (pu.kind.id === 'multi') {
        const live = balls.filter(b => b.stuck === null);
        for (const b of live.slice(0, 3)) {
          for (const spread of [-0.45, 0.45]) {
            const sp = Math.hypot(b.vx, b.vy) || speedNow();
            const ang = Math.atan2(b.vy, b.vx) + spread;
            balls.push({
              x: b.x, y: b.y,
              vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
              stuck: null, trail: [],
            });
          }
        }
      }
    }

    // ---- frame ------------------------------------------------------------
    api.onFrame(dt => {
      t += dt;
      shake = Math.max(0, shake - dt * 4);
      layoutWall(false);      // before any physics, so collisions use live geometry

      for (const p of players) {
        if (!p) continue;
        p.joinPulse = Math.max(0, p.joinPulse - dt);
        // Ease toward the finger rather than snapping: a snap on a 4K table
        // reads as a teleport and makes the ball bounce feel arbitrary.
        p.x += (p.target - p.x) * Math.min(1, dt * 30);
        clampPaddle(p);
      }

      if (!over) {
        if (launchAt && t >= launchAt && joinedCount()) {
          if (!balls.length) spawnBall();
          else { launchAll(); launchAt = 0; }
        }
        for (const b of [...balls]) moveBall(b, dt);

        const pfall = api.h * 0.30 * dt;
        for (const pu of powerups) {
          pu.y += pfall;
          pu.spin += dt * 3;
          const p = guardAt(pu.x);
          if (p && pu.y >= paddleY() - api.h * 0.01 && pu.y <= floorY() &&
              Math.abs(pu.x - p.x) < paddleHalf(p) + api.w * 0.012) {
            collectPower(pu, p);
            pu.dead = true;
          }
        }
        powerups = powerups.filter(pu => !pu.dead && pu.y < api.h);
      }

      for (const s of sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 420 * dt; s.life -= dt; }
      sparks = sparks.filter(s => s.life > 0);
      for (const b of bricks) if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 4);

      draw();
    });

    // ---- drawing ----------------------------------------------------------
    const BRICK_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7'];

    function draw() {
      const w = api.w, h = api.h, A = accent();

      g.save();
      if (shake > 0) g.translate(api.rand(-1, 1) * shake * 9, api.rand(-1, 1) * shake * 9);

      // backdrop
      const bg = g.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#0a1020');
      bg.addColorStop(0.6, '#080b14');
      bg.addColorStop(1, '#05070d');
      g.fillStyle = bg;
      g.fillRect(-20, -20, w + 40, h + 40);

      g.strokeStyle = 'rgba(120,150,200,.05)';
      g.lineWidth = 1;
      for (let x = 0; x < w; x += 54) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, floorY()); g.stroke(); }

      // bricks
      for (const b of bricks) {
        if (!b.alive) continue;
        const col = BRICK_COLORS[b.row % BRICK_COLORS.length];
        g.fillStyle = col;
        g.globalAlpha = b.hp < b.maxHp ? 0.62 : 1;
        roundRect(b.x, b.y, b.w, b.h, Math.min(6, b.h * 0.25));
        g.fill();
        g.globalAlpha = 1;

        // top highlight, so a flat rectangle reads as a solid block
        g.fillStyle = 'rgba(255,255,255,.22)';
        g.fillRect(b.x + 2, b.y + 2, b.w - 4, Math.max(2, b.h * 0.16));

        if (b.hp < b.maxHp) {                       // cracked
          g.strokeStyle = 'rgba(0,0,0,.45)';
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(b.x + b.w * 0.25, b.y + b.h * 0.2);
          g.lineTo(b.x + b.w * 0.45, b.y + b.h * 0.62);
          g.lineTo(b.x + b.w * 0.7, b.y + b.h * 0.35);
          g.stroke();
        }
        if (b.flash > 0) {
          g.fillStyle = `rgba(255,255,255,${b.flash * 0.8})`;
          roundRect(b.x, b.y, b.w, b.h, Math.min(6, b.h * 0.25));
          g.fill();
        }
      }

      // sparks
      for (const s of sparks) {
        g.globalAlpha = Math.max(s.life / s.max, 0);
        g.fillStyle = BRICK_COLORS[s.row % BRICK_COLORS.length];
        g.fillRect(s.x, s.y, 4, 4);
      }
      g.globalAlpha = 1;

      // power-ups
      for (const pu of powerups) {
        const r = api.w * 0.016;
        g.save();
        g.translate(pu.x, pu.y);
        g.rotate(Math.sin(pu.spin) * 0.35);
        g.shadowColor = pu.kind.color;
        g.shadowBlur = 18;
        g.fillStyle = pu.kind.color;
        roundRect(-r, -r * 0.62, r * 2, r * 1.24, r * 0.3);
        g.fill();
        g.shadowBlur = 0;
        g.fillStyle = '#08111c';
        g.font = '700 ' + Math.round(r * 0.78) + 'px "Segoe UI", system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(pu.kind.label, 0, 0);
        g.restore();
      }

      // the floor: a live edge, because everything past it is lost
      g.strokeStyle = 'rgba(255,90,90,.30)';
      g.lineWidth = 2;
      g.setLineDash([14, 10]);
      g.beginPath(); g.moveTo(0, floorY()); g.lineTo(api.w, floorY()); g.stroke();
      g.setLineDash([]);

      // who is responsible for which stretch of it
      for (let k = 1; k < roster.length; k++) {
        const x = (api.w / roster.length) * k;
        g.strokeStyle = 'rgba(120,150,200,.18)';
        g.lineWidth = 1;
        g.setLineDash([6, 10]);
        g.beginPath();
        g.moveTo(x, floorY() - api.h * 0.12);
        g.lineTo(x, bandTop());
        g.stroke();
        g.setLineDash([]);
      }
      for (const p of roster) {
        g.fillStyle = COLORS[p.i % COLORS.length];
        g.globalAlpha = 0.28;
        g.fillRect(zoneLo(p) + 2, floorY() + 3, zoneWidth(p) - 4, 3);
        g.globalAlpha = 1;
      }

      // paddles
      for (const p of players) {
        if (!p) continue;
        const half = paddleHalf(p);
        const ph = api.h * 0.018;
        const col = COLORS[p.i % COLORS.length];
        g.shadowColor = col;
        g.shadowBlur = 20 + p.joinPulse * 40;
        g.fillStyle = col;
        roundRect(p.x - half, paddleY(), half * 2, ph, ph * 0.5);
        g.fill();
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(255,255,255,.5)';
        g.fillRect(p.x - half + 3, paddleY() + 2, half * 2 - 6, 2);
      }

      // balls
      for (const b of balls) {
        const r = ballR();
        for (let i = 0; i < b.trail.length; i++) {
          const q = b.trail[i];
          g.globalAlpha = (i / b.trail.length) * 0.35;
          g.fillStyle = A;
          g.beginPath(); g.arc(q.x, q.y, r * (0.3 + 0.7 * i / b.trail.length), 0, Math.PI * 2); g.fill();
        }
        g.globalAlpha = 1;
        g.shadowColor = '#ffffff';
        g.shadowBlur = 16;
        g.fillStyle = '#ffffff';
        g.beginPath(); g.arc(b.x, b.y, r, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
      }

      drawBand(A);
      g.restore();
    }

    function drawBand(A) {
      const top = bandTop();
      g.fillStyle = '#0b1018';
      g.fillRect(0, top, api.w, api.h - top);
      g.strokeStyle = 'rgba(120,150,200,.18)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, top); g.lineTo(api.w, top); g.stroke();

      for (let i = 0; i < MAX_PLAYERS; i++) {
        const x0 = slotX0(i) + api.w * 0.008;
        const zw = (slotX1(i) - slotX0(i)) - api.w * 0.016;
        const y = top + api.h * 0.025;
        const zh = (api.h - top) - api.h * 0.05;
        const p = players[i];
        const col = COLORS[i % COLORS.length];

        g.fillStyle = p ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.02)';
        g.strokeStyle = p ? col : 'rgba(120,150,200,.28)';
        g.lineWidth = p ? 2 : 1;
        roundRect(x0, y, zw, zh, Math.min(14, zh * 0.2));
        g.fill();
        g.stroke();

        g.textAlign = 'center';
        g.textBaseline = 'middle';
        if (p) {
          g.fillStyle = col;
          g.font = '700 ' + Math.round(api.h * 0.026) + 'px "Segoe UI", system-ui, sans-serif';
          g.fillText('PLAYER ' + (i + 1), x0 + zw / 2, y + zh * 0.36);
          g.fillStyle = 'rgba(238,242,248,.45)';
          g.font = Math.round(api.h * 0.019) + 'px "Cascadia Mono", Consolas, monospace';
          g.fillText('SLIDE TO MOVE', x0 + zw / 2, y + zh * 0.68);
        } else {
          const pulse = 0.5 + 0.5 * Math.sin(t * 3 + i);
          g.fillStyle = `rgba(238,242,248,${0.3 + pulse * 0.4})`;
          g.font = '700 ' + Math.round(api.h * 0.026) + 'px "Segoe UI", system-ui, sans-serif';
          g.fillText('TOUCH TO JOIN', x0 + zw / 2, y + zh * 0.42);
          g.fillStyle = 'rgba(238,242,248,.28)';
          g.font = Math.round(api.h * 0.017) + 'px "Cascadia Mono", Consolas, monospace';
          g.fillText('SPLITS THE FLOOR', x0 + zw / 2, y + zh * 0.72);
        }
      }

      if (!joinedCount()) {
        g.fillStyle = 'rgba(238,242,248,.75)';
        g.font = '600 ' + Math.round(api.h * 0.038) + 'px "Segoe UI", system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText('TOUCH A SLOT BELOW TO START', api.w / 2, floorY() - api.h * 0.06);
      }
    }

    function roundRect(x, y, w, h, r) {
      const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
      g.beginPath();
      g.moveTo(x + rr, y);
      g.arcTo(x + w, y, x + w, y + h, rr);
      g.arcTo(x + w, y + h, x, y + h, rr);
      g.arcTo(x, y + h, x, y, rr);
      g.arcTo(x, y, x + w, y, rr);
      g.closePath();
    }
  },
});
