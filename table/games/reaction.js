/* Whack — hit the live targets, leave the dead ones alone. */
VSGames.register({
  id: 'reaction',
  name: 'Whack',
  howto: 'Tap every GREEN target. Never tap a RED one. Twelve hits wins; three mistakes loses.',

  mount(api) {
    const TARGET_HITS = 12;
    const MAX_MISTAKES = 3;
    const COLS = 4, ROWS = 3;

    let hits = 0;
    let mistakes = 0;

    const grid = api.el('div',
      'position:absolute;inset:0;display:grid;padding:3vmin;gap:1.6vmin;' +
      'grid-template-columns:repeat(' + COLS + ',1fr);grid-template-rows:repeat(' + ROWS + ',1fr);');
    api.layer.appendChild(grid);

    const hud = api.el('div',
      'position:absolute;left:50%;bottom:2vmin;transform:translateX(-50%);z-index:3;' +
      'font:700 2.2vmin "Cascadia Mono",Consolas,monospace;letter-spacing:.2em;color:#7f8ba3;' +
      'pointer-events:none;');
    api.layer.appendChild(hud);

    function updateHud() {
      api.progress(hits + ' / ' + TARGET_HITS);
      hud.textContent = 'MISTAKES ' + mistakes + ' / ' + MAX_MISTAKES;
    }

    const cells = [];
    for (let i = 0; i < COLS * ROWS; i++) {
      const cell = api.el('div',
        'border-radius:1.6vmin;background:#141a26;border:1px solid #232c3d;' +
        'transition:background .12s ease, transform .1s ease, box-shadow .12s ease;');
      cell.dataset.state = 'off';
      cell.dataset.cell = String(i);
      grid.appendChild(cell);
      cells.push(cell);
    }

    function setState(cell, state) {
      cell.dataset.state = state;
      if (state === 'good') {
        cell.style.background = '#35d07f';
        cell.style.boxShadow = '0 0 4vmin rgba(53,208,127,.5)';
        cell.style.transform = 'scale(1.03)';
      } else if (state === 'bad') {
        cell.style.background = '#ff4d4d';
        cell.style.boxShadow = '0 0 4vmin rgba(255,77,77,.5)';
        cell.style.transform = 'scale(1.03)';
      } else {
        cell.style.background = '#141a26';
        cell.style.boxShadow = 'none';
        cell.style.transform = 'scale(1)';
      }
    }

    // Difficulty ramps by shortening how long a target stays up.
    function lifespan() {
      return Math.max(620, 1500 - hits * 70);
    }

    function popOne() {
      if (api.finished) return;
      const idle = cells.filter(c => c.dataset.state === 'off');
      if (!idle.length) return;
      const cell = idle[api.randInt(0, idle.length - 1)];
      const bad = Math.random() < 0.3;
      setState(cell, bad ? 'bad' : 'good');
      api.beep(bad ? 240 : 560, 45, 'square', 0.05);
      api.after(lifespan(), () => {
        if (cell.dataset.state !== 'off') setState(cell, 'off');
      });
    }

    api.onTap(point => {
      const rect = api.layer.getBoundingClientRect();
      const el = document.elementFromPoint(point.x + rect.left, point.y + rect.top);
      if (!el || el.dataset.cell === undefined) return;
      const state = el.dataset.state;
      if (state === 'good') {
        hits++;
        setState(el, 'off');
        api.beep(820, 70, 'triangle', 0.09);
        updateHud();
        if (hits >= TARGET_HITS) return api.win();
      } else if (state === 'bad') {
        mistakes++;
        setState(el, 'off');
        api.beep(140, 220, 'sawtooth', 0.1);
        updateHud();
        if (mistakes >= MAX_MISTAKES) return api.lose('too many mistakes');
      }
    });

    updateHud();
    api.every(560, popOne);
    api.after(200, popOne);
  },
});
