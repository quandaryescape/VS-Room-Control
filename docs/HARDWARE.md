# Hardware setup

## Network

Put everything on one wired VLAN if you can. The camera feed is peer-to-peer
between the two table PCs, so the two tables must be able to reach each other
directly — a guest-wifi style network with client isolation will break the
video (and only the video; everything else still works).

Give every device a static IP or a DHCP reservation. The config file is full of
addresses and you do not want them moving.

| Device | Port |
|---|---|
| VS server | 8990 |
| Wall Player (per room) | 8991 |
| Quandary Control | 3000 |
| Smart lights | varies by brand |

---

## Smart lights

Set `rooms.<key>.lights` in `config.json`. Five drivers ship:

### TP-Link Kasa (`kasa`) — recommended

Plugs (HS100/HS103/KP115) and bulbs (KL series). Spoken to over the local LAN
protocol on TCP 9999 — **no cloud account, no internet, no npm package**. The
driver identifies each device on first use and picks the right command set for
a plug, a bulb, or a power strip.

```json
"lights": { "driver": "kasa", "devices": ["192.168.1.31", "192.168.1.32"] }
```

Turn off "Remote Control" in the Kasa app if you want to be certain nothing
reaches out to the internet mid-game.

### Shelly (`shelly`)

```json
"lights": {
  "driver": "shelly",
  "devices": ["192.168.1.41"],
  "options": { "gen": 2, "channel": 0 }
}
```

`gen: 1` for Shelly 1/1PM/Dimmer, `gen: 2` for Plus/Pro.

### Philips Hue (`hue`)

```json
"lights": {
  "driver": "hue",
  "devices": ["3", "4", "5"],
  "options": { "bridge": "192.168.1.50", "username": "your-api-username" }
}
```

Hue gets the best strobe of any driver: the Strobe sabotage uses the bridge's
own `lselect` alert instead of hammering on/off commands over the network, so
it flashes cleanly and in sync.

### Home Assistant (`hass`)

```json
"lights": {
  "driver": "hass",
  "devices": ["light.room_a_main", "switch.room_a_lamp"],
  "options": { "url": "http://192.168.1.60:8123", "token": "long-lived-token" }
}
```

Use this if your lighting is already in Home Assistant — it covers Zigbee,
Z-Wave, Lutron, and anything else HA speaks.

### Raw webhook (`webhook`)

The escape hatch for relay boards, Arduino sketches, and DMX controllers with
an HTTP front end:

```json
"lights": {
  "driver": "webhook",
  "options": {
    "on":  "http://192.168.1.70/relay/1?turn=on",
    "off": "http://192.168.1.70/relay/1?turn=off",
    "method": "GET"
  }
}
```

### A note on strobing

Smart bulbs and relays are slow — 200–800ms round trip is normal, and relays
have a finite click count. The strobe interval is therefore floored at 400ms
(default 700ms) so the effect looks deliberate rather than like dropped
commands. If you want a genuinely fast strobe, use a dedicated DMX or DJ
strobe fixture on a smart plug: switch the *plug* on with `blackout`-style
control and let the fixture do the flashing.

**Photosensitive epilepsy:** the strobe sabotage flashes room lighting. Put a
warning in your pre-game briefing and waiver, and keep `strobe.seconds` short.
You can disable it outright with `"strobe": { "enabled": false }`.

---

## Cameras

Each table PC has a USB camera pointed at *its own* players. That table
publishes its camera; the *other* table displays it. So Room A's screen shows
Room B's team.

The same camera is also what the **Wall Takeover** sabotage puts on the other
room's four projectors, so it is worth aiming it at the whole team rather than
just whoever is standing at the table — it will end up ten feet wide on a wall.

### The secure-origin problem

Browsers only hand out cameras on a "secure origin". `http://localhost` counts;
`http://192.168.1.20:8990` does **not**. Since the table loads from the VS
server over the LAN, you need one of these:

**Option 1 — the launcher flag (what `Start-Table.bat` does).** Chrome's
`--unsafely-treat-insecure-origin-as-secure` marks one specific origin as
trusted. It applies to that launch only, uses a throwaway profile, and does not
affect normal browsing on the machine. This is the least fuss for a fixed
installation.

**Option 2 — HTTPS with a self-signed certificate.** More setup, no special
flags, and the browser will still warn once per profile unless you install the
certificate into the machine's trust store.

If the camera is blocked, the table shows **CAMERA BLOCKED** over a static
pattern and everything else keeps working — the feed is a nice-to-have, not a
dependency. The Wall Takeover sabotage falls back to a clip or a glitch effect
in that case.

### Picking the right camera

If a table PC has both an internal webcam and your USB camera, set a hint:

```json
"camera": { "enabled": true, "label": "Logitech" }
```

It matches a substring of the device label. You can also override per-launch
with `?cam=Logitech` on the table URL.

---

## Audio

Sabotage sounds play out of the *victim's* table PC audio output — the table is
already in the room and already has speakers wired to it. Nothing extra to
install; the browser plays the file.

Browsers block audio until the user interacts with the page, which is why the
table opens on a **TAP TO BEGIN** screen. That one tap unlocks audio for the
session. `Start-Table.bat` also passes `--autoplay-policy=no-user-gesture-required`
as a belt-and-braces measure.

Drop your own sounds into `table/sounds/` and list them in `config.json`:

```json
"sounds": [
  { "id": "airhorn", "label": "Air Horn", "file": "airhorn.mp3" }
]
```

Placeholder `.wav` files ship so the system is audible out of the box. Replace
them with real recordings — they are synthesised approximations, not good
audio. See [table/sounds/README.md](../table/sounds/README.md).

---

## Projectors / Wall Player

Each room's projector PC runs the modified Wall Player from `wallplayer/`. See
[wallplayer/CHANGES.md](../wallplayer/CHANGES.md) for what changed.

Set a shared token so only the VS server can drive the walls. In the Wall
Player's `config.json`:

```json
{ "folder": "C:\\Videos", "vsToken": "pick-something-long" }
```

and the same string in the VS server's config:

```json
"wallPlayer": { "enabled": true, "url": "http://192.168.1.21:8991", "token": "pick-something-long" }
```

> Windows paths in JSON need **doubled** backslashes: `"C:\\Videos"`. A
> malformed `config.json` silently reverts every setting to defaults — the
> modified Wall Player now prints a loud warning when this happens, but it is
> still the most common setup mistake.

### Takeover clips

The Wall Takeover sabotage plays a video on all four walls. List filenames from
the Wall Player's video folder:

```json
"sabotageVideos": ["static.mp4", "taunt.mp4"]
```

With none listed it falls back to a glitch effect plus large text across the
walls, which works fine — the clips are an upgrade, not a requirement.

### Testing the walls

The Wall Player's own control panel now has a **VS Sabotage** strip with buttons
for every effect and a text box that burns a message across all four walls. All
test effects last 15 seconds and restore themselves, so you cannot leave the
walls dark by experimenting.
