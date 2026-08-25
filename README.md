# VS Room Control

Head-to-head layer for two identical escape rooms. Each room runs the same
game; a giant touchscreen table in each room shows a live camera feed of the
opposing team and lets players **sabotage** them — by winning a random
mini-game first.

It sits *alongside* Quandary Control rather than replacing it. Quandary keeps
running the room exactly as it does today; this only reaches in to read the
clock and, when a sabotage calls for it, bend it. **Quandary Control itself is
not modified.**

```
                    ┌──────────────────────────────┐
                    │        VS SERVER             │
                    │  match state · sabotages     │
                    │  mini-games · WebRTC signal  │
                    └───┬─────────┬─────────┬──────┘
          ┌─────────────┘         │         └──────────────┐
          │                       │                        │
 ┌────────▼────────┐   ┌──────────▼─────────┐   ┌──────────▼─────────┐
 │  TABLE A / B    │   │   WALL PLAYER      │   │  QUANDARY CONTROL  │
 │  touchscreen    │   │   4 projectors     │   │  (unmodified)      │
 │  games, feed,   │   │   per room         │   │  timer, hints,     │
 │  speakers       │   │                    │   │  variables         │
 └────────┬────────┘   └────────────────────┘   └────────────────────┘
          │                       ┌──────────────┐
          └── camera P2P ─────────│ SMART LIGHTS │
              (table ↔ table)     └──────────────┘
```

---

## What a round actually feels like

1. The GM arms the VS round from the operator dashboard (or a puzzle in
   Quandary does it via a webhook).
2. A team taps the one giant button on their table: **PLAY FOR A SABOTAGE**.
3. They're dealt a random mini-game — flappy-bird clone, Simon, a three-lane
   runner, a Flow-style linking puzzle, whack-a-mole, or a memory grid. 60–90
   seconds.
4. Win, and they get a menu of sabotages to fire at the *other* room. Lose, and
   they wait 20 seconds and try again.
5. The sabotage lands next door: lights die, lights strobe, an air horn goes
   off, their four walls glitch out, or their clock starts running double.
6. The saboteurs go on a two-minute cooldown before they can play again.

---

## Quick start

On the machine that will run the VS server (either table PC, the Quandary PC,
or a small box — it just needs to reach the lights, both Wall Player PCs, and
Quandary Control):

```bash
npm install
```

Copy the config and edit it:

```bash
copy config.example.json config.json
```

Then start it:

```bash
Start-VSServer.bat
```

It prints the URLs you need:

```
  Operator dashboard : http://192.168.1.20:8990/operator/
  Table A            : http://192.168.1.20:8990/table/?room=A
  Table B            : http://192.168.1.20:8990/table/?room=B
```

On each table PC, copy `Start-Table.bat`, set `ROOM` and `SERVER` at the top,
and drop a shortcut into `shell:startup`.

---

## What you must configure

Everything lives in `config.json`. The three things that will not work until
you fill them in:

| Setting | Where to find it |
|---|---|
| `rooms.A.quandaryRoomId` | Quandary's `GET /api/v1/rooms`, or the room's admin page |
| `rooms.A.lights.driver` + `devices` | your smart switch IPs — see [docs/HARDWARE.md](docs/HARDWARE.md) |
| `rooms.A.wallPlayer.url` | `http://<that room's projector PC>:8991` |

Anything not configured is simply *not offered to players*. No lights
configured means "Kill The Lights" never appears on the sabotage menu — the
button is never shown rather than shown and broken.

Check your wiring at any time with **Probe hardware** on the operator
dashboard, which pings the lights, both Wall Player PCs, and Quandary.

---

## The pieces

| Folder | What it is | Runs on |
|---|---|---|
| `server/` | VS server: match state, sabotage routing, hardware adapters | one machine |
| `table/` | the touchscreen UI and the six mini-games | each table PC (browser) |
| `operator/` | GM dashboard for the VS layer | any browser |
| `wallplayer/` | **modified** Wall Player — adds a sabotage API | each projector PC |

`wallplayer/` is your existing Wall Player with three endpoints added. See
[wallplayer/CHANGES.md](wallplayer/CHANGES.md) for exactly what changed and how
to drop it in.

---

## Sabotages

| | Sabotage | Needs |
|---|---|---|
| 🌑 | **Kill The Lights** — 20s of darkness | lights |
| ⚡ | **Strobe** — 15s of flashing | lights |
| 📢 | **Annoying Noise** — one horrible sound | table speakers |
| 🎛️ | **Soundboard** — 60s of firing whatever you like | table speakers |
| ⏩ | **Speed Trap** — defuse in 30s or run at 2x for 3 min | Quandary |
| 🔒 | **Lockout** — they can't fight back for 5 minutes | — |
| 📺 | **Wall Takeover** — your team's camera live on all four of their walls | Wall Player + a camera |
| 🌫️ | **Dim The Walls** — drain the light and colour | Wall Player |
| ⏱️ | **Steal A Minute** — 60s straight off their clock | Quandary |

Durations, labels and which ones are enabled are all in `config.json`. Full
detail and tuning advice in [docs/SABOTAGES.md](docs/SABOTAGES.md).

---

## Safety rails

Escape rooms fail in the dark, so every effect is built to expire on its own:

- **ALL STOP** on the operator dashboard cancels every running effect, restores
  the lights and walls, clears lockouts, and stops any clock acceleration.
- Effects carry their own expiry **inside the Wall Player process**, so if the
  VS server crashes mid-sabotage the projectors still come back by themselves.
- Ending the match restores both rooms automatically.
- Killing the VS server (Ctrl-C or closing the window) restores both rooms on
  the way out.
- A projector PC that is off or rebooting never blocks a sabotage from reaching
  the lights and speakers — every hardware call is fire-and-forget with a
  3-second timeout.

---

## Further reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces talk, and the state machine
- [docs/MINIGAMES.md](docs/MINIGAMES.md) — the six games, difficulty tuning, and adding your own
- [docs/QUANDARYCONTROL.md](docs/QUANDARYCONTROL.md) — exactly how the bridge works, and how to drive VS from a puzzle
- [docs/HARDWARE.md](docs/HARDWARE.md) — lights, cameras, audio, projectors, network
- [docs/SABOTAGES.md](docs/SABOTAGES.md) — the catalog, tuning, and adding your own
