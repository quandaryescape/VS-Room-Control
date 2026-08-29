/* Settings screen for the VS layer.
 *
 * Reads and writes the two sections of config.json that are safe to change
 * between games: which mini-games are in the pool, the rules block, and the
 * sabotage catalog. Hardware wiring is not here on purpose — see the note on
 * the page.
 *
 * The server is the authority on what is valid. This screen does light
 * client-side guarding so the obvious mistakes are caught before a round trip,
 * but it never assumes a save succeeded: the reply is what updates the view.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const pin = new URLSearchParams(location.search).get('pin') || '';

  // Carry the PIN through to the dashboard link, or "back" lands on a page
  // that immediately refuses to talk to the server.
  if (pin) $('back').href = './?pin=' + encodeURIComponent(pin);

  let dirty = false;

  function api(path, opts) {
    return fetch(path, Object.assign({}, opts, {
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        pin ? { 'X-VS-Pin': pin } : {}
      ),
    })).then(async res => {
      const body = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
      if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status));
      return body;
    });
  }

  function message(text, tone) {
    const el = $('msg');
    el.textContent = text;
    el.className = 'msg' + (tone ? ' ' + tone : '');
  }

  function markDirty() {
    dirty = true;
    $('save').disabled = false;
    message('unsaved changes');
  }

  // ---- rendering -------------------------------------------------------
  const RULE_FIELDS = [
    ['cooldownSeconds', 'Cooldown', 'Seconds a team waits after firing a sabotage before they can play again.', 0, 3600],
    ['lockoutSeconds', 'Lockout', 'How long the Lockout sabotage stops the victims fighting back.', 0, 3600],
    ['minigameTimeLimitSeconds', 'Mini-game time limit', 'Applies to every game and overrides each game’s own limit. Set 0 to use per-game limits instead.', 0, 900],
    ['sabotageChoiceSeconds', 'Sabotage choice', 'How long the winners get to pick a sabotage before it lapses.', 5, 300],
    ['maxSabotagesPerTeam', 'Max per team', 'Cap on sabotages one team may fire in a match. 0 means unlimited.', 0, 99],
    ['avoidRepeatCount', 'Avoid repeats', 'Do not deal the same game again until this many others have been played.', 0, 7],
  ];

  function renderRules(rules) {
    const host = $('rules');
    host.innerHTML = '';

    for (const [key, title, hint, min, max] of RULE_FIELDS) {
      const row = document.createElement('label');
      row.className = 'row';
      row.innerHTML =
        '<span class="row-label"><span>' + title + '</span>' +
        '<span class="row-hint"></span></span>';
      row.querySelector('.row-hint').textContent = hint;

      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.value = rules[key] === undefined ? '' : rules[key];
      input.dataset.rule = key;
      input.addEventListener('input', () => {
        markDirty();
        // The pool warning depends on this one, so keep it honest as it changes.
        if (key === 'avoidRepeatCount') updateMinigameNote();
      });
      row.appendChild(input);
      host.appendChild(row);
    }

    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML =
      '<span class="row-label"><span>Armed only</span>' +
      '<span class="row-hint">On: teams can only earn and fire sabotages once the match is armed. ' +
      'Off: the VS layer is live from the moment the table loads.</span></span>';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = rules.armedOnly !== false;
    box.id = 'armedOnly';
    box.addEventListener('change', markDirty);
    row.appendChild(box);
    host.appendChild(row);
  }

  function renderMinigames(list) {
    const host = $('minigames');
    host.innerHTML = '';

    for (const game of list) {
      const card = document.createElement('label');
      card.className = 'card' + (game.enabled ? '' : ' off');

      const top = document.createElement('div');
      top.className = 'card-top';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = game.enabled;
      box.dataset.minigame = game.id;
      box.addEventListener('change', () => {
        card.classList.toggle('off', !box.checked);
        markDirty();
        updateMinigameNote();
      });

      const title = document.createElement('span');
      title.className = 'card-title';
      title.textContent = game.name;

      top.appendChild(box);
      top.appendChild(title);
      if (game.defuse) {
        const badge = document.createElement('span');
        badge.className = 'badge warn';
        badge.textContent = 'defuse';
        badge.title = 'Eligible for the Speed Trap defuse challenge';
        top.appendChild(badge);
      }

      const blurb = document.createElement('div');
      blurb.className = 'card-blurb';
      blurb.textContent = game.blurb + ' · ' + game.timeLimit + 's';

      card.appendChild(top);
      card.appendChild(blurb);
      host.appendChild(card);
    }
    updateMinigameNote();
  }

  function enabledMinigames() {
    return [...document.querySelectorAll('[data-minigame]')]
      .filter(b => b.checked)
      .map(b => b.dataset.minigame);
  }

  function updateMinigameNote() {
    const on = enabledMinigames().length;
    const repeat = Number(($('rules').querySelector('[data-rule="avoidRepeatCount"]') || {}).value || 0);
    let text = on + (on === 1 ? ' game' : ' games') + ' in the pool.';
    if (!on) {
      text += ' At least one has to stay on — an empty pool means the table cannot deal a game at all.';
    } else if (on <= repeat) {
      text += ' "Avoid repeats" is ' + repeat + ', which is not smaller than the pool, so the' +
        ' server will fall back to repeating games rather than run out.';
    }
    $('minigameNote').textContent = text;
  }

  function renderSabotages(list) {
    const host = $('sabotages');
    host.innerHTML = '';

    for (const sab of list) {
      const card = document.createElement('div');
      card.className = 'card' + (sab.enabled ? '' : ' off');
      card.dataset.sabotage = sab.id;

      const top = document.createElement('label');
      top.className = 'card-top';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = sab.enabled;
      box.dataset.enabled = sab.id;
      box.addEventListener('change', () => {
        card.classList.toggle('off', !box.checked);
        markDirty();
      });

      const title = document.createElement('span');
      title.className = 'card-title';
      title.textContent = (sab.icon ? sab.icon + ' ' : '') + sab.label;

      top.appendChild(box);
      top.appendChild(title);
      card.appendChild(top);

      const blurb = document.createElement('div');
      blurb.className = 'card-blurb';
      blurb.textContent = sab.blurb;
      card.appendChild(blurb);

      if (sab.needs && sab.needs.length) {
        const badge = document.createElement('div');
        badge.style.marginTop = '8px';
        for (const need of sab.needs) {
          const b = document.createElement('span');
          b.className = 'badge';
          b.textContent = 'needs ' + need;
          b.style.marginRight = '6px';
          badge.appendChild(b);
        }
        card.appendChild(badge);
      }

      const params = document.createElement('div');
      params.className = 'params';

      const labelRow = document.createElement('label');
      labelRow.className = 'row';
      labelRow.innerHTML = '<span class="row-label"><span>Label</span></span>';
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.value = sab.label;
      labelInput.placeholder = sab.defaultLabel;
      labelInput.maxLength = 40;
      labelInput.dataset.label = sab.id;
      labelInput.addEventListener('input', markDirty);
      labelRow.appendChild(labelInput);
      params.appendChild(labelRow);

      // Only numeric parameters are editable. Anything else in a sabotage's
      // defaults is structural (video lists, driver options) and belongs in
      // the file, not on a dashboard.
      for (const [key, value] of Object.entries(sab.params || {})) {
        if (typeof value !== 'number') continue;
        const row = document.createElement('label');
        row.className = 'row';
        row.innerHTML = '<span class="row-label"><span></span></span>';
        row.querySelector('.row-label span').textContent = key;

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.value = value;
        input.dataset.param = key;
        input.dataset.for = sab.id;
        input.addEventListener('input', markDirty);
        row.appendChild(input);
        params.appendChild(row);
      }

      card.appendChild(params);
      host.appendChild(card);
    }
  }

  // ---- load / save -----------------------------------------------------
  function load() {
    message('loading…');
    $('save').disabled = true;
    return api('/api/admin/settings')
      .then(data => {
        // Rules first: the pool note reads avoidRepeatCount out of the rendered
        // rules block, and would otherwise report 0 until something is touched.
        renderRules(data.rules);
        renderMinigames(data.minigames);
        renderSabotages(data.sabotages);
        dirty = false;
        $('save').disabled = true;
        message('loaded');
      })
      .catch(err => {
        message(
          /HTTP 40[13]/.test(err.message)
            ? 'refused — add ?pin=… to the URL to match operatorPin in config.json'
            : 'could not load settings: ' + err.message,
          'bad'
        );
      });
  }

  function collect() {
    const rules = {};
    for (const input of document.querySelectorAll('[data-rule]')) {
      if (input.value === '') continue;
      rules[input.dataset.rule] = Number(input.value);
    }
    rules.armedOnly = $('armedOnly').checked;
    rules.minigames = enabledMinigames();

    const sabotages = {};
    for (const card of document.querySelectorAll('[data-sabotage]')) {
      const id = card.dataset.sabotage;
      const entry = { enabled: card.querySelector('[data-enabled]').checked };
      const label = card.querySelector('[data-label]');
      if (label && label.value.trim()) entry.label = label.value.trim();
      for (const input of card.querySelectorAll('[data-param]')) {
        if (input.value === '') continue;
        entry[input.dataset.param] = Number(input.value);
      }
      sabotages[id] = entry;
    }
    return { rules: rules, sabotages: sabotages };
  }

  function save() {
    const payload = collect();
    if (!payload.rules.minigames.length) {
      return message('at least one mini-game must stay enabled', 'bad');
    }
    $('save').disabled = true;
    message('saving…');
    api('/api/admin/settings', { method: 'POST', body: JSON.stringify(payload) })
      .then(() => load().then(() => message('saved — live now, no restart needed', 'good')))
      .catch(err => {
        message(err.message, 'bad');
        $('save').disabled = false;
      });
  }

  $('save').addEventListener('click', save);
  $('reload').addEventListener('click', () => load());

  // A half-finished edit that silently vanishes on a stray click is worse than
  // a prompt, especially on a dashboard someone is using between games.
  window.addEventListener('beforeunload', ev => {
    if (!dirty) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  load();
})();
