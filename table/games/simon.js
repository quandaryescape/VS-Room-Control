/* Sequence — watch the pattern, tap it back. Doubles as a Speed Trap defuse. */
VSGames.register({
  id: 'simon',
  name: 'Sequence',
  howto: 'Watch the panels light up, then repeat the pattern. Five rounds to win.',

  mount(api) {
    const ROUNDS_TO_WIN = api.tune(4, 5, 7);
    const PADS = [
      { color: '#35d07f', lit: '#8bffc4', tone: 392 },
      { color: '#ff4d4d', lit: '#ff9d9d', tone: 523 },
      { color: '#37b7ff', lit: '#9fe0ff', tone: 659 },
      { color: '#f2a93b', lit: '#ffd68f', tone: 784 },
    ];

    const wrap = api.el('div',
      'position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;' +
      'gap:1.4vmin;padding:3vmin;');
    api.layer.appendChild(wrap);

    const status = api.el('div',
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;' +
      'background:#07090f;border:1px solid #232c3d;border-radius:2vmin;padding:2vmin 3.5vmin;' +
      'font:800 3vmin "Segoe UI",system-ui,sans-serif;letter-spacing:.1em;pointer-events:none;' +
      'box-shadow:0 0 6vmin rgba(0,0,0,.6);', 'WATCH');
    api.layer.appendChild(status);

    const nodes = PADS.map((pad, i) => {
      const el = api.el('div',
        'border-radius:2vmin;background:' + pad.color + ';opacity:.32;' +
        'transition:opacity .09s ease, transform .09s ease;');
      el.dataset.index = String(i);
      wrap.appendChild(el);
      return el;
    });

    let sequence = [];
    let inputIndex = 0;
    let acceptingInput = false;
    let round = 0;

    function flash(i, ms) {
      const el = nodes[i];
      el.style.opacity = '1';
      el.style.transform = 'scale(0.97)';
      api.beep(PADS[i].tone, Math.min(ms, 260), 'sine', 0.1);
      api.after(ms, () => {
        el.style.opacity = '.32';
        el.style.transform = 'scale(1)';
      });
    }

    function playSequence() {
      acceptingInput = false;
      status.textContent = 'WATCH';
      status.style.color = '#eef2f8';
      // Later rounds play back faster, so the difficulty climbs on both axes.
      const gap = Math.max(320, 620 - round * 55);
      sequence.forEach((padIndex, i) => {
        api.after(500 + i * gap, () => flash(padIndex, gap * 0.6));
      });
      api.after(500 + sequence.length * gap + 150, () => {
        acceptingInput = true;
        inputIndex = 0;
        status.textContent = 'REPEAT';
        status.style.color = '#35d07f';
      });
    }

    function nextRound() {
      round++;
      api.progress(round + ' / ' + ROUNDS_TO_WIN);
      sequence.push(api.randInt(0, 3));
      playSequence();
    }

    api.onTap(point => {
      if (!acceptingInput) return;
      const el = document.elementFromPoint(
        point.x + api.layer.getBoundingClientRect().left,
        point.y + api.layer.getBoundingClientRect().top
      );
      if (!el || el.dataset.index === undefined) return;
      const picked = Number(el.dataset.index);
      flash(picked, 180);

      if (picked !== sequence[inputIndex]) {
        acceptingInput = false;
        status.textContent = 'WRONG';
        status.style.color = '#ff4d4d';
        return api.after(400, () => api.lose('broke the sequence'));
      }

      inputIndex++;
      if (inputIndex >= sequence.length) {
        acceptingInput = false;
        if (round >= ROUNDS_TO_WIN) {
          status.textContent = 'CLEAR';
          status.style.color = '#35d07f';
          return api.after(300, () => api.win());
        }
        status.textContent = 'GOOD';
        api.after(700, nextRound);
      }
    });

    api.after(400, nextRound);
  },
});
