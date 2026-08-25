'use strict';

// Live camera relay: gets a room's table camera onto the OTHER room's four
// projector walls during a Wall Takeover.
//
// The table's camera is a browser MediaStream, so it can only leave the page as
// WebRTC (which mpv cannot receive) or as images. So the table grabs frames off
// its own video element and POSTs them here as JPEGs, and this serves them back
// as a standard multipart MJPEG stream — exactly what an IP camera produces,
// and something mpv/ffmpeg opens natively with a plain URL.
//
// That keeps the projector PCs completely unchanged: no browser window fighting
// mpv for the screen, no z-order problem, no extra software. All four mpv
// instances just "play a file" that happens to be the other room's faces.

const log = require('./log').scoped('camrelay');

const BOUNDARY = 'vsframe';
const STALE_MS = 4000;     // a feed with no frame this recent is considered dead
const MAX_FRAME = 3 * 1024 * 1024;

class CamRelay {
  constructor() {
    this.feeds = new Map(); // roomKey -> { frame, ts, clients:Set, frames:n }
  }

  feed(roomKey) {
    if (!this.feeds.has(roomKey)) {
      this.feeds.set(roomKey, { frame: null, ts: 0, clients: new Set(), frames: 0, accepting: false });
    }
    return this.feeds.get(roomKey);
  }

  // A feed only accepts frames between open() and close(). Without this gate,
  // a frame already in flight when a takeover ends lands just after the buffer
  // is cleared, and the NEXT takeover opens on a stale shot of the room from
  // minutes earlier. It also means a table that never got the stop message
  // cannot keep a feed alive on its own.
  open(roomKey) {
    const feed = this.feed(roomKey);
    feed.accepting = true;
    feed.frame = null;
    feed.ts = 0;
  }

  close(roomKey) {
    const feed = this.feeds.get(roomKey);
    if (!feed) return;
    feed.accepting = false;
    this.clear(roomKey);
  }

  // Called by the table, many times a second, while a takeover is running.
  pushFrame(roomKey, buffer) {
    if (!buffer || !buffer.length || buffer.length > MAX_FRAME) return false;
    const feed = this.feed(roomKey);
    if (!feed.accepting) return false;
    const first = !feed.frame;
    feed.frame = buffer;
    feed.ts = Date.now();
    feed.frames++;
    if (first) log.info(`Room ${roomKey} camera feed started`, { bytes: buffer.length });

    for (const res of feed.clients) this.writeFrame(res, buffer);
    return true;
  }

  writeFrame(res, buffer) {
    try {
      res.write(`--${BOUNDARY}\r\n`);
      res.write('Content-Type: image/jpeg\r\n');
      res.write(`Content-Length: ${buffer.length}\r\n\r\n`);
      res.write(buffer);
      res.write('\r\n');
    } catch (e) { /* the socket dropped; the close handler cleans up */ }
  }

  hasLiveFrame(roomKey) {
    const feed = this.feeds.get(roomKey);
    return !!(feed && feed.frame && Date.now() - feed.ts < STALE_MS);
  }

  // One mpv instance (or a browser, for testing) attaching to the stream.
  attach(roomKey, req, res) {
    const feed = this.feed(roomKey);

    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
    });

    feed.clients.add(res);
    log.info(`Camera stream opened for room ${roomKey}`, { viewers: feed.clients.size });

    // Send whatever we already have so the wall lights up immediately rather
    // than staying black until the next frame arrives.
    if (feed.frame) this.writeFrame(res, feed.frame);

    // Some decoders will not show a frame until a second one arrives, and a
    // still room produces very few. Repeat the last frame slowly to keep the
    // stream flowing and the connection alive.
    const keepalive = setInterval(() => {
      if (feed.frame && Date.now() - feed.ts > 500) this.writeFrame(res, feed.frame);
    }, 500);

    const done = () => {
      clearInterval(keepalive);
      feed.clients.delete(res);
      log.info(`Camera stream closed for room ${roomKey}`, { viewers: feed.clients.size });
    };
    req.on('close', done);
    req.on('error', done);
    res.on('error', done);
  }

  viewers(roomKey) {
    const feed = this.feeds.get(roomKey);
    return feed ? feed.clients.size : 0;
  }

  // Drop the buffered frame when a takeover ends so a later one can never
  // flash a stale image of the room from ten minutes ago.
  clear(roomKey) {
    const feed = this.feeds.get(roomKey);
    if (!feed) return;
    feed.frame = null;
    feed.ts = 0;
    for (const res of feed.clients) {
      try { res.end(); } catch (e) {}
    }
    feed.clients.clear();
  }

  stats() {
    const out = {};
    for (const [key, feed] of this.feeds) {
      out[key] = {
        live: this.hasLiveFrame(key),
        accepting: feed.accepting,
        frames: feed.frames,
        viewers: feed.clients.size,
      };
    }
    return out;
  }
}

module.exports = { CamRelay };
