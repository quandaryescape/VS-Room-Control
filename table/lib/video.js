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

  let socket = null;
  let roomKey = null;
  let localEl = null;
  let remoteEl = null;
  let onState = () => {};

  let localStream = null;
  let pc = null;
  let peerKey = null;
  let isInitiator = false;
  let pendingCandidates = [];

  async function openCamera(labelHint) {
    if (localStream) return localStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser will not expose cameras on an insecure origin. '
        + 'Launch it with Start-Table.bat, or serve the table over HTTPS.');
    }

    const constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } }, audio: false };

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

  function teardown() {
    if (pc) {
      try { pc.close(); } catch (e) {}
      pc = null;
    }
    pendingCandidates = [];
    if (remoteEl) remoteEl.srcObject = null;
    onState('offline');
  }

  function createPeer() {
    teardown();
    pc = new RTCPeerConnection(PC_CONFIG);

    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }

    pc.ontrack = ev => {
      if (remoteEl && ev.streams[0]) {
        remoteEl.srcObject = ev.streams[0];
        remoteEl.play().catch(() => {});
      }
    };

    pc.onicecandidate = ev => {
      if (ev.candidate && peerKey) {
        socket.emit('rtc:signal', { to: peerKey, data: { candidate: ev.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') onState('live');
      else if (state === 'failed' || state === 'disconnected') {
        onState('offline');
        // A dropped LAN link usually comes back; rebuild rather than sit dead.
        if (isInitiator) setTimeout(() => { if (peerKey) offer(); }, 2000);
      }
    };

    return pc;
  }

  async function offer() {
    if (!peerKey) return;
    createPeer();
    const desc = await pc.createOffer({ offerToReceiveVideo: true });
    await pc.setLocalDescription(desc);
    socket.emit('rtc:signal', { to: peerKey, data: { sdp: pc.localDescription } });
    onState('connecting');
  }

  async function handleSignal(from, data) {
    peerKey = from;

    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        // The non-initiator always (re)builds on an incoming offer, which also
        // recovers cleanly when the other table reloads mid-game.
        createPeer();
        await pc.setRemoteDescription(data.sdp);
        for (const c of pendingCandidates.splice(0)) {
          await pc.addIceCandidate(c).catch(() => {});
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc:signal', { to: from, data: { sdp: pc.localDescription } });
        onState('connecting');
      } else if (data.sdp.type === 'answer' && pc) {
        await pc.setRemoteDescription(data.sdp).catch(() => {});
        for (const c of pendingCandidates.splice(0)) {
          await pc.addIceCandidate(c).catch(() => {});
        }
      }
      return;
    }

    if (data.candidate) {
      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        await pc.addIceCandidate(data.candidate).catch(() => {});
      } else {
        pendingCandidates.push(data.candidate);
      }
    }
  }

  window.VSVideo = {
    async init(opts) {
      socket = opts.socket;
      roomKey = opts.roomKey;
      localEl = opts.localEl;
      remoteEl = opts.remoteEl;
      onState = opts.onState || (() => {});

      try {
        await openCamera(opts.cameraLabel);
      } catch (e) {
        onState('nocamera', e.message);
      }

      socket.on('rtc:initiate', ({ peer }) => {
        peerKey = peer;
        isInitiator = true;
        offer().catch(err => onState('offline', err.message));
      });

      socket.on('rtc:standby', ({ peer }) => {
        peerKey = peer;
        isInitiator = false;
        onState('connecting');
      });

      socket.on('rtc:signal', ({ from, data }) => {
        handleSignal(from, data).catch(err => console.warn('rtc signal failed', err));
      });

      socket.on('rtc:peer-gone', ({ peer }) => {
        if (peer === peerKey) { peerKey = null; teardown(); }
      });
    },

    hasCamera() { return !!localStream; },
    retryCamera(label) { return openCamera(label); },
  };
})();
