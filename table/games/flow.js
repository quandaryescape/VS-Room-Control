/* Reroute — connect every pair of matching dots without crossing.
 *
 * Winning only requires every pair to be linked; there is no need to fill the
 * board. The puzzles are still generated from full-coverage solutions and
 * verified by an independent solver, so a valid set of non-crossing paths is
 * guaranteed to exist — the relaxed rule can only make a board easier.
 *
 * They are also screened for difficulty: a board is only kept if the obvious
 * approach (draw every pair by its shortest free path) fails at least ~45% of
 * the time. Without that screen roughly half of them could be cleared without
 * thinking, which is what made the game this one replaced too easy.
 *
 * They are baked in rather than generated in the browser, because handing a
 * team an unsolvable board mid-game is not recoverable in front of customers.
 *
 * Encoding: "WH" followed by four digits per pair — ax ay bx by.
 */
VSGames.register({
  id: 'flow',
  name: 'Reroute',
  howto: 'Drag between matching dots to connect them. Paths cannot cross each other.',

  puzzles: [
    // 5x5
    '553321311000243440', '550444432313110122', '550232220100414204',
    '552022123130334304', '5540424304032122313002', '5511030423133444212000',
    '5533313022211011030200', '5513444322124241201004',
    // 6x6
    '6602223214043545515012', '6600222341315354150501', '6615444543334142000105',
    '6652323134443525020142', '6644232231325242100025', '66352313212243443020020305',
    '66404232131454553435030241', '66253343354540300203141311', '66422212030425354344233341',
    '66340414020122215051434435',
    // 7x7
    '77001525233310204151454606', '77266564516123240304344433', '77004050525336350515132351',
    '77420313112153541626656400',
  ],

  mount(api) {
    const COLORS = ['#ff4d4d', '#37b7ff', '#35d07f', '#f2a93b', '#c66bff', '#ff7ac8'];

    // ---- load a random verified puzzle ----
    const raw = this.puzzles[Math.floor(Math.random() * this.puzzles.length)];
    const W = Number(raw[0]);
    const H = Number(raw[1]);
    const pairs = [];
    for (let i = 2; i < raw.length; i += 4) {
      pairs.push({
        a: [Number(raw[i]), Number(raw[i + 1])],
        b: [Number(raw[i + 2]), Number(raw[i + 3])],
      });
    }

    const { g } = api.makeCanvas();

    const cells = new Int8Array(W * H).fill(-1);   // which colour owns each cell
    const paths = pairs.map(() => []);            // ordered cells per colour
    const at = (x, y) => y * W + x;

    // Endpoints are permanently owned by their colour.
    pairs.forEach((p, c) => { cells[at(p.a[0], p.a[1])] = c; cells[at(p.b[0], p.b[1])] = c; });

    let active = -1;          // colour currently being dragged
    let lastCell = null;

    // ---- geometry ----
    function metrics() {
      const pad = Math.min(api.w, api.h) * 0.06;
      const size = Math.min(api.w - pad * 2, api.h - pad * 2);
      const cell = size / Math.max(W, H);
      return {
        cell,
        ox: (api.w - cell * W) / 2,
        oy: (api.h - cell * H) / 2,
      };
    }

    function cellAt(px, py) {
      const m = metrics();
      const x = Math.floor((px - m.ox) / m.cell);
      const y = Math.floor((py - m.oy) / m.cell);
      if (x < 0 || y < 0 || x >= W || y >= H) return null;
      return [x, y];
    }

    const isEndpoint = (c, x, y) =>
      (pairs[c].a[0] === x && pairs[c].a[1] === y) || (pairs[c].b[0] === x && pairs[c].b[1] === y);

    function endpointColourAt(x, y) {
      for (let c = 0; c < pairs.length; c++) if (isEndpoint(c, x, y)) return c;
      return -1;
    }

    const complete = c => {
      const p = paths[c];
      if (p.length < 2) return false;
      const first = p[0], last = p[p.length - 1];
      return isEndpoint(c, first[0], first[1]) && isEndpoint(c, last[0], last[1])
        && !(first[0] === last[0] && first[1] === last[1]);
    };

    // ---- path editing ----
    function clearPath(c) {
      for (const [x, y] of paths[c]) {
        if (!isEndpoint(c, x, y)) cells[at(x, y)] = -1;
      }
      paths[c] = [];
    }

    // Truncate a colour's path so it no longer occupies (x,y) or anything after
    // it. This is what makes dragging through someone else's line cut it.
    function truncateAt(c, x, y) {
      const i = paths[c].findIndex(p => p[0] === x && p[1] === y);
      if (i < 0) return;
      for (const [px, py] of paths[c].slice(i)) {
        if (!isEndpoint(c, px, py)) cells[at(px, py)] = -1;
      }
      paths[c] = paths[c].slice(0, i);
    }

    function beginAt(x, y) {
      const endc = endpointColourAt(x, y);
      if (endc >= 0) {
        // Starting from a dot always restarts that colour's path.
        clearPath(endc);
        paths[endc] = [[x, y]];
        active = endc;
        lastCell = [x, y];
        api.beep(360 + endc * 60, 40, 'square', 0.05);
        return;
      }
      const c = cells[at(x, y)];
      if (c >= 0) {
        // Grabbing mid-path: keep everything up to here and carry on from it.
        const i = paths[c].findIndex(p => p[0] === x && p[1] === y);
        if (i >= 0) {
          truncateAt(c, x, y);
          paths[c].push([x, y]);
          cells[at(x, y)] = c;
          active = c;
          lastCell = [x, y];
        }
      }
    }

    function extendTo(x, y) {
      if (active < 0) return;
      const path = paths[active];
      const head = path[path.length - 1];
      if (!head) return;
      if (head[0] === x && head[1] === y) return;

      // Only orthogonal single steps.
      if (Math.abs(head[0] - x) + Math.abs(head[1] - y) !== 1) return;

      // Retracing our own path pulls it back.
      const own = path.findIndex(p => p[0] === x && p[1] === y);
      if (own >= 0) {
        for (const [px, py] of path.slice(own + 1)) {
          if (!isEndpoint(active, px, py)) cells[at(px, py)] = -1;
        }
        paths[active] = path.slice(0, own + 1);
        return;
      }

      const occupant = cells[at(x, y)];

      // The far dot of our own colour finishes the line.
      if (occupant === active && isEndpoint(active, x, y)) {
        path.push([x, y]);
        api.beep(720, 90, 'triangle', 0.09);
        active = -1;
        checkWin();
        return;
      }

      // Another colour's dot is a wall; another colour's *path* gets cut.
      if (occupant >= 0) {
        if (isEndpoint(occupant, x, y)) return;
        truncateAt(occupant, x, y);
      }

      path.push([x, y]);
      cells[at(x, y)] = active;
    }

    function checkWin() {
      const connected = pairs.filter((_, c) => complete(c)).length;
      api.progress(`${connected} / ${pairs.length} linked`);
      if (connected === pairs.length) api.after(200, () => api.win());
    }

    api.onDrag({
      start(pt) {
        const c = cellAt(pt.x, pt.y);
        if (c) beginAt(c[0], c[1]);
        checkWin();
      },
      move(pt) {
        if (active < 0) return;
        const c = cellAt(pt.x, pt.y);
        if (!c) return;
        if (lastCell && lastCell[0] === c[0] && lastCell[1] === c[1]) return;
        lastCell = c;
        extendTo(c[0], c[1]);
        checkWin();
      },
      end() {
        active = -1;
        lastCell = null;
        checkWin();
      },
    });

    checkWin();

    // ---- drawing ----
    api.onFrame(() => {
      const m = metrics();
      const cell = m.cell;

      g.fillStyle = '#080b12';
      g.fillRect(0, 0, api.w, api.h);

      // board
      const bx = m.ox, by = m.oy, bw = cell * W, bh = cell * H;
      g.fillStyle = '#101623';
      roundRect(bx - cell * 0.12, by - cell * 0.12, bw + cell * 0.24, bh + cell * 0.24, cell * 0.2);
      g.fill();

      g.strokeStyle = 'rgba(120,150,200,.13)';
      g.lineWidth = 1;
      for (let x = 0; x <= W; x++) {
        g.beginPath(); g.moveTo(bx + x * cell, by); g.lineTo(bx + x * cell, by + bh); g.stroke();
      }
      for (let y = 0; y <= H; y++) {
        g.beginPath(); g.moveTo(bx, by + y * cell); g.lineTo(bx + bw, by + y * cell); g.stroke();
      }

      // paths
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (let c = 0; c < pairs.length; c++) {
        const path = paths[c];
        if (path.length < 2) continue;
        const done = complete(c);
        g.strokeStyle = COLORS[c % COLORS.length];
        g.lineWidth = cell * (done ? 0.42 : 0.34);
        g.globalAlpha = done ? 1 : 0.85;
        g.beginPath();
        path.forEach(([x, y], i) => {
          const cx = bx + (x + 0.5) * cell;
          const cy = by + (y + 0.5) * cell;
          i ? g.lineTo(cx, cy) : g.moveTo(cx, cy);
        });
        g.stroke();
        g.globalAlpha = 1;
      }

      // dots
      for (let c = 0; c < pairs.length; c++) {
        const done = complete(c);
        for (const [x, y] of [pairs[c].a, pairs[c].b]) {
          const cx = bx + (x + 0.5) * cell;
          const cy = by + (y + 0.5) * cell;
          const r = cell * 0.3;
          if (done) {
            g.fillStyle = COLORS[c % COLORS.length];
            g.globalAlpha = 0.25;
            g.beginPath(); g.arc(cx, cy, r * 1.6, 0, Math.PI * 2); g.fill();
            g.globalAlpha = 1;
          }
          g.fillStyle = COLORS[c % COLORS.length];
          g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
          g.fillStyle = 'rgba(0,0,0,.35)';
          g.beginPath(); g.arc(cx, cy, r * 0.42, 0, Math.PI * 2); g.fill();
        }
      }

      // the live head, so a finger mid-drag has something to aim with
      if (active >= 0) {
        const path = paths[active];
        const head = path[path.length - 1];
        if (head) {
          const cx = bx + (head[0] + 0.5) * cell;
          const cy = by + (head[1] + 0.5) * cell;
          g.strokeStyle = COLORS[active % COLORS.length];
          g.lineWidth = cell * 0.06;
          g.globalAlpha = 0.7;
          g.beginPath(); g.arc(cx, cy, cell * 0.4, 0, Math.PI * 2); g.stroke();
          g.globalAlpha = 1;
        }
      }
    });

    function roundRect(x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }
  },
});
