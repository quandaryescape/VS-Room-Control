/* VS Table — the touchscreen client.
 *
 * URL: /table/?room=A   (the room key must match config.json)
 * The room key is remembered in localStorage, so a kiosk shortcut only needs
 * the query string once.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const roomKey = params.get('room') || localStorage.getItem('vsRoom') || '';
  if (roomKey) localStorage.setItem('vsRoom', roomKey);
  if (params.get('debug') === '1') document.body.classList.add('debug');

  document.body.dataset.room = roomKey;

  let socket = null;
  let state = null;
  let clockSkew = 0;          // serverNow - localNow
  let sounds = [];
  const audioCache = new Map();

  let camPush = null;         // frame pusher, live during a Wall Takeover
  let game = null;            // active mini-game instance
  let gameToken = null;
  let defuseGame = null;
  let defuseToken = null;

  // Bumped every time the active game or defuse changes. Any callback still
  // holding an older number belongs to a round that is over and is ignored,
  // so a stale instance can never write to the HUD or end the current round.
  let gameGen = 0;
  let defuseGen = 0;

  // Camera steering. `steerOwn` flips the feed between THEIR camera (the
  // default) and this table's own, and decides which one the edge buttons move.
  let camStatus = null;       // { own, opponent } from the server
  let steerOwn = false;
  let ownTouched = 0;
  let camDeniedAt = 0;
  let camGrabbedAt = 0;

  // ---------------------------------------------------------------- helpers

  const serverNow = () => Date.now() + clockSkew;

  function mmss(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function toast(text, tone) {
    const node = document.createElement('div');
    node.className = 'toast' + (tone ? ' ' + tone : '');
    node.textContent = text;
    $('toasts').appendChild(node);
    setTimeout(() => node.remove(), 3600);
  }

  function playSound(sound, volume) {
    if (!sound || !sound.file) return;
    let audio = audioCache.get(sound.file);
    if (!audio) {
      audio = new Audio('/sounds/' + encodeURIComponent(sound.file));
      audio.preload = 'auto';
      audioCache.set(sound.file, audio);
    }
    audio.currentTime = 0;
    audio.volume = volume === undefined ? 1 : volume;
    audio.play().catch(() => {
      // If the browser still has us blocked, at least make a synthesised
      // noise so the sabotage is never silent.
      VSGames.beep(180, 400, 'sawtooth', 0.2);
      toast('Audio is blocked on this table — tap the screen once.', 'bad');
    });
  }

  // Pull every sabotage sound into memory up front. A sabotage must never wait
  // on a disk read, and a missing file should be obvious now rather than in
  // the middle of a game.
  function preloadSounds() {
    for (const sound of sounds) {
      if (audioCache.has(sound.file)) continue;
      const audio = new Audio('/sounds/' + encodeURIComponent(sound.file));
      audio.preload = 'auto';
      audio.addEventListener('error', () => {
        console.warn('[sounds] missing: table/sounds/' + sound.file
          + ' — either add the file or remove "' + sound.id + '" from config.json');
      });
      audioCache.set(sound.file, audio);
    }
  }

  // ------------------------------------------------------- camera frame push
  //
  // During a Wall Takeover this room's camera goes up on the OTHER room's four
  // projectors. mpv cannot receive WebRTC, so instead of streaming peer to
  // peer we grab frames off our own camera element and POST them as JPEGs; the
  // VS server republishes them as MJPEG, which mpv opens like any other URL.

  function startCamPush(opts) {
    stopCamPush();
    const video = $('localVideo');
    // No early return when the camera isn't open yet: a table that has just
    // (re)loaded is asked for frames before its camera is up, and grab()
    // already skips until the video has a size.
    if (!video) return;

    const fps = Math.max(2, Math.min(opts.fps || 12, 25));
    const quality = opts.quality || 0.6;
    const maxWidth = opts.width || 960;
    let canvas = null;
    let g = null;
    let inFlight = false;
    let grabStartedAt = 0;
    let warnedStall = false;

    // Frames also go to the GM's dashboard; only a takeover is "on their walls".
    $('onAir').hidden = !opts.onAir;

    // Every step here is asynchronous, so the page never sits waiting on the
    // graphics chip. The previous drawImage(video) + toBlob pair could make
    // the page wait on a GPU readback — tolerable for a 20-second takeover,
    // but not for a GM camera view left running all game.
    const grab = async () => {
      // Skip rather than queue: on a slow link it is better to drop frames
      // than to build a backlog and fall behind the room.
      if (inFlight) {
        if (!warnedStall && Date.now() - grabStartedAt > 5000) {
          warnedStall = true;
          console.warn('[cam] a frame grab has been stuck for 5s — frames paused');
        }
        return;
      }
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      const w = Math.min(maxWidth, vw);
      const h = Math.round((vh / vw) * w);
      inFlight = true;
      grabStartedAt = Date.now();
      try {
        const bitmap = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
        if (!canvas || canvas.width !== w || canvas.height !== h) {
          canvas = new OffscreenCanvas(w, h);
          g = canvas.getContext('2d');
        }
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        await fetch('/api/camframe/' + encodeURIComponent(roomKey), {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg' },
          body: blob,
        });
      } catch (e) {
        // A dropped frame is fine; the next tick tries again.
      } finally {
        inFlight = false;
        warnedStall = false;
      }
    };

    camPush = setInterval(grab, Math.round(1000 / fps));
    grab();
    console.info('[cam] pushing frames at ' + fps + 'fps');
  }

  function stopCamPush() {
    if (camPush) { clearInterval(camPush); camPush = null; }
    const badge = $('onAir');
    if (badge) badge.hidden = true;
  }

  // ------------------------------------------------------------------- boot

  function boot() {
    if (!roomKey) {
      $('bootErr').textContent = 'No room set. Open this table as /table/?room=A or /table/?room=B';
      return;
    }
    $('bootRoom').textContent = 'TABLE ' + roomKey.toUpperCase();

    const wake = () => {
      document.removeEventListener('pointerdown', wake);
      VSGames.audio();                       // unlock WebAudio on the gesture
      document.body.classList.remove('booting');
      $('boot').hidden = true;
      $('shell').hidden = false;
      connect();
      startVideo();
      requestFullscreen();
    };
    document.addEventListener('pointerdown', wake);
  }

  function requestFullscreen() {
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }

  function startVideo() {
    VSVideo.init({
      socket,
      roomKey,
      localEl: $('localVideo'),
      remoteEl: $('remoteVideo'),
      cameraLabel: params.get('cam') || '',
      onState(status, detail) {
        const off = $('feedOff');
        if (status === 'live') {
          off.hidden = true;
        } else {
          off.hidden = false;
          off.querySelector('span').textContent =
            status === 'nocamera' ? 'CAMERA BLOCKED'
              : status === 'connecting' ? 'CONNECTING…'
                : 'NO SIGNAL';
          if (detail) console.warn('[video]', detail);
        }
      },
    }).then(() => VSCamCtl.attach(VSVideo.stream(), socket));
  }

  // ------------------------------------------------------------------ socket

  function connect() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket.emit('hello', { role: 'table', room: roomKey });
      $('linkDot').className = 'dot on';
    });

    socket.on('disconnect', () => {
      $('linkDot').className = 'dot bad';
    });

    socket.on('catalog', payload => {
      sounds = payload.sounds || [];
      preloadSounds();
      renderSoundboardButtons();
    });

    socket.on('state', next => {
      clockSkew = next.now - Date.now();
      state = next;
      if (!sounds.length && next.sounds) { sounds = next.sounds; preloadSounds(); renderSoundboardButtons(); }
      render();
    });

    socket.on('play_sound', ({ sound, volume }) => playSound(sound, volume));

    socket.on('cam:push', opts => startCamPush(opts || {}));
    socket.on('cam:stop', () => stopCamPush());

    socket.on('cam:status', next => {
      const was = camStatus && camStatus.own && camStatus.own.holder;
      camStatus = next;
      // Tell a team when the other room grabs their camera, and how to take
      // it back — they outrank the other room on their own camera.
      if (next.own && next.own.holder === 'opponent' && was !== 'opponent'
          && Date.now() - camGrabbedAt > 20000) {
        camGrabbedAt = Date.now();
        toast(steerOwn
          ? 'They\'re steering your camera — press any arrow to take it back.'
          : 'They\'re steering your camera — tap your camera preview to take it back.', 'bad');
      }
      renderCam();
    });

    socket.on('incoming', payload => showIncoming(payload));
    socket.on('fired', payload => showFired(payload));
    socket.on('toast', ({ text, tone }) => toast(text, tone));

    socket.on('defused', ({ ok, multiplier }) => {
      closeDefuse();
      if (ok) toast('Defused. Your clock is safe.', 'good');
      else toast('Too slow — your clock is running at ' + multiplier + 'x.', 'bad');
    });
  }

  // ------------------------------------------------------------------ render

  function setView(name) {
    for (const view of document.querySelectorAll('.view')) {
      view.classList.toggle('active', view.dataset.view === name);
    }
  }

  function render() {
    if (!state) return;

    $('roomName').textContent = state.name.toUpperCase();
    $('oppName').textContent = state.opponentName.toUpperCase();
    $('readyOpp').textContent = state.opponentName;
    $('feedTitle').textContent = steerOwn ? 'YOUR CAM' : state.opponentName.toUpperCase() + ' CAM';
    $('tally').textContent = state.sabotagesUsed;

    const opp = state.opponentState;
    $('oppDot').className = 'dot' + (opp && opp.tableConnected ? ' on' : '');
    $('oppPhase').textContent = opp ? phaseLabel(opp.phase) : '—';
    $('oppLast').textContent = opp && opp.lastAction ? 'last: ' + opp.lastAction.label : '';

    renderClock();

    // The defuse takeover outranks everything else on the table.
    if (state.defuse) {
      openDefuse(state.defuse);
      return;
    }
    if (defuseGame && !state.defuse) closeDefuse();

    // A mini-game is running in its own full-screen layer.
    if (state.attempt && gameToken === state.attempt.token) {
      renderGameClock();
      return;
    }
    if (state.attempt && gameToken !== state.attempt.token) {
      openGame(state.attempt);
      return;
    }
    if (!state.attempt && game) closeGame();

    setView(state.phase);
    if (state.phase === 'choose' && state.offer) renderOffer(state.offer);
    renderSoundboard();
  }

  function phaseLabel(phase) {
    return ({
      idle: 'STANDING BY',
      ready: 'READY',
      playing: 'IN A CHALLENGE',
      choose: 'CHOOSING A SABOTAGE',
      cooldown: 'RECHARGING',
      lockout: 'LOCKED OUT',
      defusing: 'DEFUSING',
      spent: 'OUT OF STRIKES',
    })[phase] || phase.toUpperCase();
  }

  function renderClock() {
    const timer = state.timer;
    const clock = $('clock');
    if (!timer) {
      clock.textContent = '--:--';
      clock.classList.remove('low');
    } else {
      clock.textContent = mmss(timer.remaining);
      clock.classList.toggle('low', timer.remaining <= 300);
    }
    $('clockFlag').hidden = !state.spedUp;
  }

  // Local countdowns tick between server pushes so the numbers stay smooth.
  const pct = (left, total) => Math.max(0, Math.min(100, (left / Math.max(total, 1)) * 100)) + '%';

  setInterval(() => {
    if (!state) return;
    const now = serverNow();
    const d = state.durations || {};

    if (state.phase === 'cooldown' && state.cooldownUntil) {
      const left = (state.cooldownUntil - now) / 1000;
      $('cooldownCount').textContent = mmss(left);
      $('cooldownBar').style.width = pct(left, d.cooldown);
    }
    if (state.phase === 'lockout' && state.lockoutUntil) {
      const left = (state.lockoutUntil - now) / 1000;
      $('lockoutCount').textContent = mmss(left);
      $('lockoutBar').style.width = pct(left, d.lockout);
    }
    if (state.phase === 'choose' && state.offer) {
      const left = (state.offer.expiresAt - now) / 1000;
      $('chooseBar').style.width = pct(left, d.choose);
    }
    if (state.soundboardUntil > now) {
      $('sbCount').textContent = mmss((state.soundboardUntil - now) / 1000);
    }
    if (state.defuse && defuseToken === state.defuse.token) {
      const left = Math.max(0, (state.defuse.expiresAt - now) / 1000);
      $('defuseCount').textContent = Math.ceil(left);
      $('defuseBar').style.width = pct(left, d.defuse);
    }
    if (game && state.attempt) renderGameClock();
    if (steerOwn && Date.now() - ownTouched > OWN_CAM_IDLE_MS) setSteerOwn(false);
  }, 250);

  // ------------------------------------------------------------ mini-games

  $('playBtn').addEventListener('click', () => {
    $('playBtn').disabled = true;
    socket.emit('game:request', {}, result => {
      $('playBtn').disabled = false;
      if (!result.ok) toast(result.error, 'bad');
    });
  });

  function openGame(attempt) {
    closeGame();
    gameGen++;
    gameToken = attempt.token;

    $('gameName').textContent = attempt.gameName;
    $('gameBlurb').textContent = attempt.blurb;
    $('gameProgress').textContent = '';
    $('startTitle').textContent = attempt.gameName;
    const def = VSGames.get(attempt.gameId);
    $('startHow').textContent = def ? def.howto : attempt.blurb;
    $('gameStart').hidden = false;
    $('gameEnd').hidden = true;
    $('gameLayer').hidden = false;

    // Assign onclick rather than addEventListener: there is exactly one handler
    // slot, so a round that is never started cannot leave a live handler behind.
    // It used to - every abandoned or timed-out round left one attached, and the
    // next START press fired all of them at once, spawning a hidden game per
    // stale round that kept beeping and wrote its own "FAILED" over whatever
    // was actually on screen.
    const gen = gameGen;
    $('startBtn').onclick = () => {
      if (gen !== gameGen) return;
      $('startBtn').onclick = null;
      $('gameStart').hidden = true;
      game = VSGames.create(attempt.gameId, $('gameHost'), {
        onProgress: text => { if (gen === gameGen) $('gameProgress').textContent = text; },
        onWin: () => { if (gen === gameGen) finishGame(true); },
        onLose: reason => { if (gen === gameGen) finishGame(false, reason); },
      }, { difficulty: difficulty() });
    };
  }

  // Difficulty rides along with the room state, because the games run here in
  // the browser and cannot read the server's config themselves. Falling back
  // to 'normal' matters: a game must never be unplayable because a snapshot
  // arrived a moment late.
  function difficulty() {
    return (state && state.difficulty) || 'normal';
  }

  function renderGameClock() {
    if (!state || !state.attempt) return;
    const total = (state.durations && state.durations.minigame) || 90;
    const left = (state.attempt.expiresAt - serverNow()) / 1000;
    const bar = $('gameTimeBar');
    bar.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
    bar.classList.toggle('low', left <= 15);
  }

  function finishGame(won, reason) {
    const gen = gameGen;
    const token = gameToken;
    $('endTitle').textContent = won ? 'CLEARED' : 'FAILED';
    $('endTitle').className = won ? 'win' : 'lose';
    $('endSub').textContent = won
      ? 'Choose your sabotage…'
      : (reason ? 'You ' + reason + '.' : 'Better luck next round.');
    $('gameEnd').hidden = false;

    socket.emit('game:result', { token, won }, result => {
      if (!result.ok) toast(result.error, 'bad');
    });

    setTimeout(() => {
      // A new round may already have started while this one was showing its
      // result screen; closing then would kill the live game instead.
      if (gen !== gameGen) return;
      closeGame();
      if (state) render();
    }, won ? 900 : 1800);
  }

  function closeGame() {
    gameGen++;                    // anything still holding the old number is dead
    $('startBtn').onclick = null;
    if (game) { game.destroy(); game = null; }
    gameToken = null;
    $('gameLayer').hidden = true;
    $('gameEnd').hidden = true;
  }

  $('quitGame').addEventListener('click', () => {
    const token = gameToken;
    closeGame();
    socket.emit('game:abandon', { token });
  });

  // -------------------------------------------------------------- sabotages

  function renderOffer(offer) {
    // Only rebuild the grid when the offer actually changes, so a repaint
    // doesn't cancel a tap that is already in flight.
    const grid = $('sabotageGrid');
    if (grid.dataset.token === offer.token) return;
    grid.dataset.token = offer.token;
    grid.innerHTML = '';

    for (const sabotage of offer.sabotages) {
      const card = document.createElement('button');
      card.className = 'sab';
      card.innerHTML =
        '<span class="sab-icon"></span>' +
        '<span class="sab-label"></span>' +
        '<span class="sab-blurb"></span>' +
        '<span class="sab-detail"></span>';
      card.querySelector('.sab-icon').textContent = sabotage.icon;
      card.querySelector('.sab-label').textContent = sabotage.label;
      card.querySelector('.sab-blurb').textContent = sabotage.blurb;
      card.querySelector('.sab-detail').textContent = sabotage.detail;
      card.addEventListener('click', () => {
        if (card.classList.contains('pick')) return;
        for (const other of grid.querySelectorAll('.sab')) other.disabled = true;
        card.classList.add('pick');
        VSGames.beep(660, 90, 'triangle', 0.1);
        socket.emit('sabotage:choose', { token: offer.token, id: sabotage.id }, result => {
          if (!result.ok) {
            toast(result.error, 'bad');
            grid.dataset.token = '';
          }
        });
      });
      grid.appendChild(card);
    }
  }

  function showIncoming({ label, icon, from }) {
    $('incIcon').textContent = icon || '⚠';
    $('incFrom').textContent = 'INCOMING FROM ' + String(from).toUpperCase();
    $('incLabel').textContent = label;
    $('incoming').hidden = false;
    VSGames.beep(120, 500, 'sawtooth', 0.16);
    setTimeout(() => VSGames.beep(120, 500, 'sawtooth', 0.16), 260);
    clearTimeout(showIncoming.timer);
    showIncoming.timer = setTimeout(() => { $('incoming').hidden = true; }, 3200);
  }

  function showFired({ label, icon, target }) {
    $('firedIcon').textContent = icon || '💥';
    $('firedLabel').textContent = label;
    $('firedTarget').textContent = 'DELIVERED TO ' + String(target).toUpperCase();
    $('fired').hidden = false;
    clearTimeout(showFired.timer);
    showFired.timer = setTimeout(() => { $('fired').hidden = true; }, 2800);
  }

  // ------------------------------------------------------------- soundboard

  function renderSoundboardButtons() {
    const grid = $('sbGrid');
    grid.innerHTML = '';
    for (const sound of sounds) {
      const button = document.createElement('button');
      button.textContent = sound.label;
      button.addEventListener('click', () => {
        socket.emit('sound:fire', { soundId: sound.id }, result => {
          if (result && !result.ok) toast(result.error, 'bad');
        });
        VSGames.beep(520, 60, 'square', 0.07);
      });
      grid.appendChild(button);
    }
  }

  function renderSoundboard() {
    const active = state.soundboardUntil > serverNow();
    $('soundboard').hidden = !active;
  }

  // ------------------------------------------------------------------ defuse

  function openDefuse(defuse) {
    if (defuseToken === defuse.token) return;
    closeGame();
    closeDefuse();
    defuseGen++;
    const gen = defuseGen;
    defuseToken = defuse.token;
    $('defuseLayer').hidden = false;
    VSGames.beep(160, 700, 'sawtooth', 0.2);

    defuseGame = VSGames.create(defuse.gameId, $('defuseHost'), {
      onProgress: () => {},
      onWin: () => {
        if (gen !== defuseGen) return;
        socket.emit('defuse:result', { token: defuse.token, success: true });
        closeDefuse();
      },
      onLose: () => {
        // A failed attempt isn't instant death — they can keep trying until
        // the countdown expires, which keeps the panic going.
        if (gen !== defuseGen) return;
        const token = defuse.token;
        closeDefuse();
        setTimeout(() => {
          if (state && state.defuse && state.defuse.token === token) openDefuse(state.defuse);
        }, 500);
      },
    }, { difficulty: difficulty() });
  }

  function closeDefuse() {
    defuseGen++;
    if (defuseGame) { defuseGame.destroy(); defuseGame = null; }
    defuseToken = null;
    $('defuseLayer').hidden = true;
  }

  // --------------------------------------------------------- camera steering
  //
  // The edge buttons over the feed steer a camera — theirs by default, or this
  // table's own after tapping the corner preview of it. Nothing moves locally:
  // every press goes to the server, which decides who wins (GM, then the
  // camera's own team, then the other team) and passes the winner's commands
  // to whichever table has that camera plugged in (lib/camctl.js).

  const OWN_CAM_IDLE_MS = 15000;   // drift back to their camera after this long untouched

  const camPad = VSCamPad($('camCtl'), {
    drive: vector => steer('cam:drive', { vector }),
    home: () => steer('cam:home', {}),
  });

  function steer(event, payload) {
    if (!socket) return;
    if (steerOwn) ownTouched = Date.now();
    payload.cam = steerOwn ? 'self' : 'opponent';
    socket.emit(event, payload, result => {
      // A held button repeats several times a second; one toast is plenty.
      if (result && !result.ok && Date.now() - camDeniedAt > 2500) {
        camDeniedAt = Date.now();
        toast(result.error, 'bad');
      }
    });
  }

  const canSteer = cam => !!(cam && cam.enabled && cam.caps
    && (cam.caps.pan || cam.caps.tilt || cam.caps.zoom));

  // `me` is 'owner' for this table's own camera, 'opponent' for theirs.
  function camView(cam, me) {
    if (!canSteer(cam)) return { steerable: false, text: '' };
    if (cam.lock === 'gm' || (cam.lock === 'owner' && me === 'opponent')) {
      return { steerable: false, text: '🔒 LOCKED BY GM', tone: 'bad' };
    }
    if (cam.holder === 'gm') return { steerable: true, busy: true, text: 'GM IS STEERING', tone: 'bad' };
    if (cam.holder === me) return { steerable: true, text: 'YOU\'RE STEERING', tone: 'good' };
    if (cam.holder) return { steerable: true, busy: me === 'opponent', text: 'THEY\'RE STEERING', tone: 'warn' };
    return { steerable: true, text: 'HOLD AN EDGE TO STEER' };
  }

  function renderCam() {
    const cam = camStatus && (steerOwn ? camStatus.own : camStatus.opponent);
    const view = camView(cam, steerOwn ? 'owner' : 'opponent');
    const ctl = $('camCtl');
    if (!view.steerable) camPad.stop();
    ctl.hidden = !view.steerable;
    ctl.classList.toggle('busy', !!view.busy);
    if (view.steerable) {
      for (const axis of ['pan', 'tilt', 'zoom']) {
        for (const button of ctl.querySelectorAll('[data-' + axis + ']')) button.hidden = !cam.caps[axis];
      }
    }
    $('camWho').textContent = view.text;
    $('camWho').className = 'cam-who' + (view.tone ? ' ' + view.tone : '');
  }

  function setSteerOwn(on) {
    if (steerOwn === on) return;
    camPad.stop();                // a held button belongs to the camera it was pressed on
    steerOwn = on;
    ownTouched = Date.now();
    $('feedBody').classList.toggle('own', on);
    if (state) $('feedTitle').textContent = on ? 'YOUR CAM' : state.opponentName.toUpperCase() + ' CAM';
    renderCam();
  }

  // The corner preview is always the OTHER camera: tap it to swap.
  $('localVideo').addEventListener('click', () => {
    if (steerOwn) return;
    if (!canSteer(camStatus && camStatus.own)) {
      toast('This table\'s camera can\'t be steered.', 'bad');
      return;
    }
    setSteerOwn(true);
  });
  $('remoteVideo').addEventListener('click', () => { if (steerOwn) setSteerOwn(false); });

  // ---------------------------------------------------------------- kick off

  boot();
})();
