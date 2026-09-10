/* Peer-to-peer camera feed between the two tables.
 *
 * Each table captures the USB camera clipped to its own screen (which is
 * pointed at its own players) and sends it to the other table. The VS server
 * only relays signalling messages — the video itself goes straight across the
 * LAN, so there is nothing to transcode and latency stays under a frame or two.
 *
 * No STUN/TURN is configured on purpose: both tables are on the same network,
 * so host candidates connect directly and the whole thing keeps working with
 * the internet unplugged.
 */
(function () {
  'use strict';

  const PC_CONFIG = { iceServers: [] };
  // A link that hasn't come up in this long asks the server to start the
  // handshake over, rather than sitting on CONNECTING for the rest of the game.
  const CONNECT_TIMEOUT_MS = 12000;
  // How long signalling waits for this table's camera before carrying on
  // without it (see init).
  const CAMERA_WAIT_MS = 8000;

  let socket = null;
  let roomKey = null;
  let localEl = null;
  let remoteEl = null;
  let onState = () => {};

  let localStream = null;
  let pc = null;
  let peerKey = null;
  let isInitiator = false;
  let session = null;          // id of the offer/answer exchange in progress
  let pendingCandidates = [];  // { session, candidate } that arrived early
  let status = 'offline';
  let watchdog = null;

  // Every signalling step runs on this chain, one at a time and in arrival
  // order, and nothing runs until the camera has opened (or failed to).
  //  - An answer built before the camera is ready carries no video, so the
  //    other room would connect and see nothing.
  //  - Handled concurrently, a fresh offer could wipe ICE candidates that had
  //    already arrived for it.
  let chain = Promise.resolve();
  function queue(step) {
    chain = chain.then(step).catch(err => console.warn('[video] signalling step failed', err));
  }

  function setStatus(next) {
    status = next;
    onState(next);
    // The operator dashboard shows each table's link, which is the quickest
    // way to tell a network problem from a camera problem.
    if (socket && socket.connected) socket.emit('rtc:state', { status: next });
    clearTimeout(watchdog);
    if (next === 'connecting') {
      watchdog = setTimeout(() => {
        if (status === 'live' || !socket || !socket.connected) return;
        console.warn('[video] still not connected after ' + CONNECT_TIMEOUT_MS / 1000 + 's, asking to start over');
        socket.emit('rtc:retry');
      }, CONNECT_TIMEOUT_MS);
    }
  }

  async function openCamera(labelHint) {
    if (localStream) return localStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser will not expose cameras on an insecure origin. '
        + 'Launch it with Start-Table.bat, or serve the table over HTTPS.');
    }

    // pan/tilt/zoom: true asks Chrome for the right to MOVE the camera as well
    // as see through it (lib/camctl.js steers the OBSBOT's gimbal). It is a
    // request, not a requirement: a camera with no motor opens exactly as
    // before and simply reports nothing to steer.
    const constraints = {
      video: {
        width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 },
        pan: true, tilt: true, zoom: true,
      },
      audio: false,
    };

    // If more than one camera is attached (many table PCs have an internal
    // webcam as well), pick the one whose label matches the config hint.
    if (labelHint) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const match = devices.find(d => d.kind === 'videoinput'
          && d.label.toLowerCase().includes(String(labelHint).toLowerCase()));
        if (match) constraints.video.deviceId = { exact: match.deviceId };
      } catch (e) { /* fall through to the default camera */ }
    }

    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (localEl) localEl.srcObject = localStream;
    return localStream;
  }

  // Close the connection without forgetting candidates that have already
  // arrived for the next one.
  function closePeer() {
    if (pc) {
      const old = pc;
      pc = null;
      try { old.close(); } catch (e) {}
    }
    if (remoteEl) remoteEl.srcObject = null;
  }

  function teardown() {
    closePeer();
    pendingCandidates = [];
    setStatus('offline');
  }

  function createPeer() {
    closePeer();
    const peer = new RTCPeerConnection(PC_CONFIG);
    const id = session;
    pc = peer;

    if (localStream) {
      for (const track of localStream.getTracks()) peer.addTrack(track, localStream);
    }

    peer.ontrack = ev => {
      if (peer === pc && remoteEl && ev.streams[0]) {
        remoteEl.srcObject = ev.streams[0];
        remoteEl.play().catch(() => {});
      }
    };

    peer.onicecandidate = ev => {
      if (ev.candidate && peerKey && peer === pc) {
        socket.emit('rtc:signal', { to: peerKey, data: { candidate: ev.candidate, session: id } });
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer !== pc) return;          // an old connection winding down
      const state = peer.connectionState;
      if (state === 'connected') setStatus('live');
      else if (state === 'failed' || state === 'disconnected') {
        setStatus('offline');
        // A dropped LAN link usually comes back; rebuild rather than sit dead.
        if (isInitiator) {
          setTimeout(() => {
            if (peer === pc && peer.connectionState !== 'connected' && peerKey) queue(offer);
          }, 2000);
        }
      }
    };

    return peer;
  }

  async function offer() {
    if (!peerKey) return;
    session = Math.random().toString(36).slice(2);
    createPeer();
    const desc = await pc.createOffer({ offerToReceiveVideo: true });
    await pc.setLocalDescription(desc);
    socket.emit('rtc:signal', { to: peerKey, data: { sdp: pc.localDescription, session } });
    setStatus('connecting');
  }

  // Candidates that turned up before the description they belong to.
  async function drainCandidates() {
    const mine = pendingCandidates.filter(c => c.session === session);
    pendingCandidates = [];
    for (const c of mine) await pc.addIceCandidate(c.candidate).catch(() => {});
  }

  async function handleSignal(from, data) {
    if (!data) return;

    if (data.sdp && data.sdp.type === 'offer') {
      // The non-initiator always (re)builds on an incoming offer, which also
      // recovers cleanly when the other table reloads mid-game.
      peerKey = from;
      isInitiator = false;
      session = data.session;
      createPeer();
      await pc.setRemoteDescription(data.sdp);
      await drainCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtc:signal', { to: from, data: { sdp: pc.localDescription, session } });
      setStatus('connecting');
      return;
    }

    if (data.sdp && data.sdp.type === 'answer') {
      // An answer to an offer this table has since replaced would pair the
      // new connection with the old one's credentials — drop it.
      if (!pc || data.session !== session || pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(data.sdp);
      await drainCandidates();
      return;
    }

    if (data.candidate) {
      if (pc && data.session === session && pc.remoteDescription && pc.remoteDescription.type) {
        await pc.addIceCandidate(data.candidate).catch(() => {});
      } else {
        pendingCandidates.push({ session: data.session, candidate: data.candidate });
        if (pendingCandidates.length > 100) pendingCandidates.shift();
      }
    }
  }

  window.VSVideo = {
    // Resolves once the camera has opened, or failed to.
    init(opts) {
      socket = opts.socket;
      roomKey = opts.roomKey;
      localEl = opts.localEl;
      remoteEl = opts.remoteEl;
      onState = opts.onState || (() => {});

      const opened = openCamera(opts.cameraLabel).catch(e => { onState('nocamera', e.message); });

      // Signalling waits for the camera, but not forever. A fresh kiosk
      // profile shows Chrome's "use and move your camera" prompt, and a table
      // nobody has tapped Allow on yet should still show the other room. If
      // the camera turns up after that, rebuild the link so it carries this
      // table's picture too.
      let gaveUp = false;
      chain = Promise.race([
        opened,
        new Promise(resolve => setTimeout(() => { gaveUp = true; resolve(); }, CAMERA_WAIT_MS)),
      ]);
      opened.then(stream => {
        if (!gaveUp || !stream) return;
        console.info('[video] camera arrived late — rebuilding the link to include it');
        queue(() => {
          if (isInitiator && peerKey) return offer();
          if (socket.connected) socket.emit('rtc:retry');
        });
      });

      // Handlers go on NOW, before the camera has finished opening. The
      // server tells a table its role the moment it says hello — while the
      // camera is still starting — and a message that arrives before its
      // handler exists is silently dropped. That used to leave one table on
      // NO SIGNAL and the other stuck on CONNECTING. The chain above holds
      // the messages until the camera is ready instead.
      socket.on('rtc:initiate', ({ peer }) => queue(() => {
        peerKey = peer;
        isInitiator = true;
        return offer();
      }));

      socket.on('rtc:standby', ({ peer }) => queue(() => {
        peerKey = peer;
        isInitiator = false;
        if (status !== 'live') setStatus('connecting');
      }));

      socket.on('rtc:signal', ({ from, data } = {}) => queue(() => handleSignal(from, data)));

      socket.on('rtc:peer-gone', ({ peer }) => queue(() => {
        if (peer === peerKey) { peerKey = null; teardown(); }
      }));

      socket.on('connect', () => socket.emit('rtc:state', { status }));

      return opened;
    },

    hasCamera() { return !!localStream; },
    stream() { return localStream; },
    retryCamera(label) { return openCamera(label); },
  };
})();
