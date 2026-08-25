# Wall Player — what changed

This is your existing Wall Player with a sabotage API bolted on. Everything the
original did — shuffle, per-screen locks, skip, mute, the stall watchdog, the
mpv auto-discovery — is untouched and behaves exactly as before.

## Dropping it in

Copy `server.js` and `index.html` over the ones on each projector PC. Keep your
existing `config.json`, `StartServer.bat`, and `mpv.exe` where they are — no
new dependencies, still zero npm packages.

Then add a shared token to that PC's `config.json`:

```json
{
  "folder": "C:\\Videos",
  "vsToken": "pick-something-long"
}
```

and put the same string in the VS server's config under
`rooms.<key>.wallPlayer.token`. Leave `vsToken` blank to skip authentication
entirely, which is reasonable on an isolated room network.

## New endpoints

All three accept an optional `X-VS-Token` header, required only if `vsToken` is
set.

### `POST /api/effect`

```json
{ "effect": "blackout", "seconds": 20 }
```

| effect | what it does |
|---|---|
| `blackout` | walls to black |
| `dim` | darken and drain colour (`level`, `desaturate`) |
| `desaturate` | greyscale |
| `hue` | rotate all colour (`value`, degrees) |
| `flash` | strobe between blown-out and black (`intervalMs`) |
| `glitch` | random colour/contrast jitter, ten times a second |
| `restore` | cancel immediately and return to normal |

### `POST /api/message`

```json
{ "text": "SABOTAGED", "seconds": 5 }
```

Large text across every wall, drawn by mpv's OSD.

### `POST /api/playall`

```json
{ "file": "static.mp4", "seconds": 20 }
```

Plays one clip on every screen at once, then returns each screen to the
shuffle. Locked screens go back to their pinned video.

It also accepts a live network stream instead of a filename:

```json
{ "url": "http://192.168.1.20:8990/api/camstream/A.mjpg", "seconds": 20, "live": true }
```

This is how the Wall Takeover sabotage puts the other room's camera on all four
walls. For a live URL the players drop their 60-second read-ahead buffer (which
would otherwise show the room as it was a minute ago) and the freeze watchdog is
suspended for the duration — an MJPEG feed has no timeline, so `time-pos` never
advances and the watchdog would otherwise "recover" a perfectly healthy takeover
by skipping off it. Both are restored when the window closes.

## How the effects are implemented

Through mpv's **video equalizer properties** (`brightness`, `contrast`,
`saturation`, `hue`) over the IPC connection that already exists — not by
swapping files. That means:

- effects apply instantly, with no reload and no black frame,
- the underlying video keeps playing and keeps its position,
- undoing an effect is one property write,
- the shuffle, the queue, and the per-screen locks are completely undisturbed.

## Safety

**Every effect carries its own expiry inside this process.** If the VS server
crashes or the network drops mid-sabotage, the walls still come back on their
own — the Wall Player is not waiting to be told.

Additionally:

- Starting any effect cancels the previous one, so effects cannot stack.
- `stopAll()` clears effects, so pressing **Stop all** never leaves the walls
  blacked out.
- A screen that is down or reconnecting is skipped without affecting the rest.
- Effect durations are clamped to 300 seconds.

## Other changes

**Loud warning on a malformed `config.json`.** The original silently caught the
parse error and ran on defaults. That is a nasty failure: a single-backslash
Windows path (`"C:\Videos"` instead of `"C:\\Videos"`) is invalid JSON, so the
folder, the locks, the mute setting *and* the VS token would all quietly revert
with no indication why. It now prints a clear message naming the likely cause.

**CORS headers** on API responses, so the VS server and the operator dashboard
can call it from another host.

**VS status in `/api/status`**, under a `vs` key — the active effect, seconds
remaining, and whether a token is required. The operator dashboard's "Probe
hardware" button reads this.

**A VS Sabotage strip in the control panel** with a button per effect and a text
box for wall messages. Test effects last 15 seconds and restore themselves.
