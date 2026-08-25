# Architecture

## Why a separate server

The VS layer needs to hold state that spans *both* rooms — whose cooldown is
running, who is locked out, which sabotage is in flight. Quandary Control's
model is one room at a time, and the brief was to leave it untouched. So the VS
server owns the cross-room state and treats Quandary as one of several
downstream systems, alongside the lights and the projectors.

That also means the failure modes stay separate. If the VS server dies mid-game
the escape room keeps running normally in Quandary; the players just stop
being able to sabotage each other.

## Processes

| Process | Port | Count | Notes |
|---|---|---|---|
| Quandary Control | 3000 | 1 | untouched |
| VS server | 8990 | 1 | this project |
| Wall Player | 8991 | 1 per room | modified copy |
| Table UI | — | 1 per room | a browser in kiosk mode |

The table UI is served *by* the VS server, so the table PCs need nothing
installed but a browser.

## Transport

- **Tables ↔ VS server**: Socket.IO. The server pushes a full room snapshot on
  every change; the table renders from that snapshot and never keeps its own
  authoritative copy. Player actions go up as acknowledged events, so the table
  gets a yes/no and an error string back for every request.
- **Table ↔ table (video)**: WebRTC, peer to peer. The VS server only relays
  signalling. Video never touches the server, so there is nothing to transcode
  and no added latency. No STUN or TURN is configured on purpose — both tables
  are on the same LAN, so host candidates connect directly and the feed keeps
  working with the internet unplugged.
- **Table → projectors (Wall Takeover)**: a second, separate video path. mpv
  cannot receive WebRTC, so during a takeover the table *also* grabs JPEG frames
  off its own camera and POSTs them to the VS server, which republishes them as
  MJPEG for the projector PCs to open as an ordinary URL. Two paths for one
  camera looks redundant, but it is what keeps the projector PCs completely
  unchanged — no second browser window fighting mpv for the screen, and no
  z-order to manage on a machine that has to be reliable for three hours a day.
- **VS server → Wall Player**: plain HTTP POST with an optional shared token.
- **VS server ↔ Quandary**: Socket.IO as a GM client for the timer, plus the
  REST API for variables.
- **VS server → lights**: whatever the driver speaks (raw TCP for Kasa, HTTP
  for everything else).

## Clock skew

Every snapshot carries the server's `now`. The table computes an offset once
per push and renders all countdowns against that, so the numbers on a table
whose Windows clock has drifted still match the server's idea of when a
cooldown ends.

## Per-room state machine

The table's phase is *derived*, never stored — it's computed from timestamps on
every snapshot, so it can't get stuck in a stale state:

```
                 ┌──────────┐
                 │   idle   │  match not armed
                 └────┬─────┘
                      │ operator arms the match
                 ┌────▼─────┐
      ┌─────────►│  ready   │◄──────────┐
      │          └────┬─────┘           │
      │               │ tap PLAY        │ cooldown expires
      │          ┌────▼─────┐           │
      │          │ playing  │           │
      │          └──┬────┬──┘           │
      │        lose │    │ win          │
      │             │    │              │
      │        ┌────▼─┐  │         ┌────┴─────┐
      └────────┤ 20s  │  │         │ cooldown │
               └──────┘  │         └────▲─────┘
                    ┌────▼─────┐        │
                    │  choose  ├────────┘
                    └──────────┘   fire a sabotage

  lockout   ─ overrides ready/cooldown while the opponent's lock runs
  defusing  ─ overrides everything; takes over the whole table
  spent     ─ optional per-team sabotage cap reached
```

`defusing` sits above the rest deliberately: being speed-trapped cancels
whatever the victim was doing on their table, which is part of the punishment.

## Anti-cheat

The table is a web page on a machine players can touch, so the server never
trusts it:

- Every mini-game attempt gets a server-issued single-use token. A "win" for an
  unknown or already-spent token is rejected.
- The server owns the attempt deadline. A win that arrives after it has expired
  is refused.
- Cooldowns, lockouts and the sabotage menu are all decided server-side. The
  menu a table receives only contains sabotages the target room can actually
  receive.

None of this makes it tamper-proof — a determined player with a keyboard could
still replay a valid token — but it means the ordinary failure modes (a stuck
page, a double tap, a reload mid-game) can't hand out free sabotages.

## Adapters

`server/adapters/` isolates every piece of hardware behind a small interface,
so swapping smart-plug brands is a config change rather than a code change:

```
lights/index.js     LightController: blackout(), strobe(), restore()
  ├── kasa.js       TP-Link local protocol over TCP 9999
  └── http-drivers  Shelly, Hue, Home Assistant, raw webhook
wallplayer.js       effect(), message(), playAll(), playStream(), restore()
quandary.js         timer mirroring, adjust(), speedUp(), hint(), setVariable()
```

`server/lib/camrelay.js` sits alongside them: it buffers the newest JPEG frame
per room and fans it out to every attached MJPEG viewer. A feed only accepts
frames between `open()` and `close()`, so a frame still in flight when a
takeover ends cannot linger and open the *next* takeover on a stale shot of the
room.

Adding a brand means writing one object with `setPower(on)` and registering it
in `DRIVERS`. Everything above it — the sabotages, the UI, the safety rails —
is unchanged.
