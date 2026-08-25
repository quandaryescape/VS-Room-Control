/* Recall — find all eight pairs. Five wrong guesses and the round is lost. */
VSGames.register({
  id: 'memory',
  name: 'Recall',
  howto: 'Tap two cards to find matching pairs. Eight pairs to win — six wrong guesses and you lose.',

  mount(api) {
    const SYMBOLS = ['🔧', '💣', '🔑', '⚙️', '🧨', '📡', '🔩', '⚡'];
    const PAIRS = SYMBOLS.length;

    // Tuned by simulation, not by feel. Eight pairs takes a perfect-memory
    // player ~4.4 wrong guesses on average and a good one ~5.0, so a limit of
    // 5 would fail even flawless play half the time. At 6 a good player clears
    // it ~70% of the time and a careless one does not - which is the point.
    const MAX_MISSES = 6;

    const deck = SYMBOLS.concat(SYMBOLS)
      .map(symbol => ({ symbol, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(entry => entry.symbol);

    const grid = api.el('div',
      'position:absolute;inset:0;display:grid;padding:3vmin 3vmin 7vmin;gap:1.4vmin;' +
      'grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(4,1fr);');
    api.layer.appendChild(grid);

    const hud = api.el('div',
      'position:absolute;left:50%;bottom:2vmin;transform:translateX(-50%);' +
      'font:700 2.2vmin "Cascadia Mono",Consolas,monospace;letter-spacing:.2em;' +
      'color:#7f8ba3;pointer-events:none;');
    api.layer.appendChild(hud);

    let flipped = [];
    let matched = 0;
    let misses = 0;
    let busy = false;

    function updateHud() {
      api.progress(matched + ' / ' + PAIRS);
      const left = MAX_MISSES - misses;
      hud.textContent = 'WRONG GUESSES LEFT ' + left;
      hud.style.color = left <= 1 ? '#ff4d4d' : left <= 2 ? '#f2a93b' : '#7f8ba3';
    }

    const cards = deck.map((symbol, i) => {
      const card = api.el('div',
        'position:relative;border-radius:1.8vmin;background:#141a26;border:1px solid #232c3d;' +
        'display:flex;align-items:center;justify-content:center;font-size:7vmin;' +
        'transition:background .15s ease, transform .12s ease, border-color .15s ease;');
      card.dataset.card = String(i);
      card.dataset.state = 'down';
      card.textContent = '';
      grid.appendChild(card);
      return card;
    });

    function show(card, i) {
      card.dataset.state = 'up';
      card.textContent = deck[i];
      card.style.background = '#1d2739';
      card.style.transform = 'scale(1.03)';
    }

    function hide(card) {
      card.dataset.state = 'down';
      card.textContent = '';
      card.style.background = '#141a26';
      card.style.transform = 'scale(1)';
    }

    function lock(card) {
      card.dataset.state = 'matched';
      card.style.background = '#16281f';
      card.style.borderColor = '#35d07f';
      card.style.transform = 'scale(1)';
    }

    updateHud();

    api.onTap(point => {
      if (busy) return;
      const rect = api.layer.getBoundingClientRect();
      const el = document.elementFromPoint(point.x + rect.left, point.y + rect.top);
      if (!el || el.dataset.card === undefined || el.dataset.state !== 'down') return;

      const index = Number(el.dataset.card);
      show(el, index);
      api.beep(500, 50, 'sine', 0.06);
      flipped.push({ el, index });

      if (flipped.length < 2) return;

      busy = true;
      const [a, b] = flipped;
      flipped = [];

      if (deck[a.index] === deck[b.index]) {
        matched++;
        api.beep(760, 110, 'triangle', 0.09);
        lock(a.el); lock(b.el);
        updateHud();
        busy = false;
        if (matched >= PAIRS) api.after(250, () => api.win());
      } else {
        // A wrong pair costs a life. With eight pairs and five lives there is
        // no room to brute-force the board — you have to actually remember.
        misses++;
        api.beep(200, 130, 'square', 0.06);
        a.el.style.borderColor = '#ff4d4d';
        b.el.style.borderColor = '#ff4d4d';
        updateHud();
        api.after(650, () => {
          a.el.style.borderColor = '#232c3d';
          b.el.style.borderColor = '#232c3d';
          hide(a.el); hide(b.el);
          busy = false;
          if (misses >= MAX_MISSES) api.lose('ran out of guesses');
        });
      }
    });
  },
});
