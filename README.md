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
3. They're dealt a random mini-game — one of nine, from threading a drone
   through laser gates to linking pairs without crossing a line. 60–90
   seconds. See [Mini-games](#mini-games) for the full set.
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

**Windows**

```bash
Start-VSServer.bat
```

**Ubuntu / Linux** (needs Node 18+)

If the scripts came off a Windows share or a fresh clone they may not be
executable yet:

```bash
chmod +x start-vsserver.sh start-table.sh install-linux.sh
```

```bash
./start-vsserver.sh
```

Either launcher creates `config.json` from `config.example.json` on first run
and installs dependencies if `node_modules` is missing. Open `config.json` and
set your room IDs, light addresses and Wall Player URLs before a real game.

It prints the URLs you need:

```
  Operator dashboard : http://192.168.1.20:8990/operator/
  Table A            : http://192.168.1.20:8990/table/?room=A
  Table B            : http://192.168.1.20:8990/table/?room=B
```

On each table PC:

- **Windows** — copy `Start-Table.bat`, set `ROOM` and `SERVER` at the top, and
  drop a shortcut into `shell:startup`.
- **Ubuntu** — see below.

---

## Starting automatically on Ubuntu

### Don't run it from a network share

Copy the project to the Ubuntu box's **local disk** first. Browsing to the
Windows share in Files and running it from there does not work: GNOME mounts
those under `/run/user/1000/gvfs/...`, which is `noexec`, and which root cannot
read at all — so `sudo ./install-linux.sh server` fails with a misleading
`command not found`. A network path is also the wrong home for a boot service,
because the mount only exists once someone has logged into the desktop.

```bash
cp -r "/run/user/1000/gvfs/ftp:host=glados.local/disk1/quandary/Programming/Vs Room/VS-Room-Control" ~/vs-room-control
```

```bash
cd ~/vs-room-control && chmod +x install-linux.sh start-vsserver.sh start-table.sh
```

The `chmod` is needed because the executable bit doesn't survive a copy over
FTP or SMB. `install-linux.sh` checks all of this and tells you what to fix.

`install-linux.sh` wires both halves into the OS so nothing needs a human at
boot.

**The server box** — a systemd service, so it starts before anyone logs in and
restarts itself if it dies:

```bash
sudo ./install-linux.sh server
```

It runs as the user who owns the checkout (not root), and gets 20 seconds on
shutdown to restore both rooms' lights and walls. Afterwards:

```bash
journalctl -u vs-server -f
```

**Each table PC** — a desktop autostart entry, so the kiosk browser comes up
with the graphical session. Run it as that table's own user, *without* `sudo`:

```bash
./install-linux.sh table --room A --server http://192.168.1.20:8990
```

`--room` and `--server` are baked into the autostart entry, so you don't need
to edit `start-table.sh` per machine. Test it without rebooting by running
`./start-table.sh` directly. For an unattended table also turn on **Settings →
Users → Automatic Login**.

The table launcher waits up to two minutes for the server to answer before
opening — the table PC is usually up before the server box is — disables screen
blanking, and clears Chrome's "didn't shut down properly" prompt, which on a
kiosk is a dialog nobody can dismiss.

### Reaching Chromium's site settings for the kiosk profile

Camera permission is stored **per profile**, and the kiosk runs with its own
`--user-data-dir`. Granting the camera in your everyday Chromium has no effect
on it. Kiosk mode also has no address bar, so there's nowhere to click.

Run the launcher windowed — same profile, same flags, just not full-screen:

```bash
./start-table.sh --windowed
```

Then click the icon at the left of the address bar → **Site settings** →
**Camera** → **Allow**, or go to `chrome://settings/content/camera`.

If the camera entry isn't offered at all, the origin isn't considered secure
and no amount of clicking will help. Press **F12** and check in the console:

```
isSecureContext          // must be true, or there is no camera API at all
navigator.mediaDevices   // undefined means the origin is insecure
```

`false`/`undefined` there means the insecure-origin flag isn't taking effect on
this build — serve the tables over HTTPS instead (see above).

### Serving the tables over HTTPS

Chrome only grants camera access on a secure origin. `start-table.sh` works
around that with `--unsafely-treat-insecure-origin-as-secure`; if that flag
isn't taking effect on your build, serve the tables over TLS instead and the
problem goes away at the source.

HTTPS here is **additive**. Plain HTTP stays on `port` for the Wall Player PCs
(mpv reads the camera relay from the command line) and Quandary's webhooks —
neither should have to trust a private CA. Only the tables move to
`httpsPort`.

A self-signed certificate is worse than useless on a kiosk: Chrome puts a
full-page interstitial in front of it that nobody can dismiss on a touchscreen
with no keyboard. Use `mkcert`, which creates a small local CA and issues from
it, so the browser is simply satisfied.

On the **server**:

```bash
sudo apt install -y mkcert libnss3-tools
```

```bash
./install-linux.sh cert --host 192.168.0.167
```

Then set `tls.enabled` to `true` in `config.json` and restart:

```bash
sudo systemctl restart vs-server
```

On each **table PC**, copy `rootCA.pem` off the server (its location is printed
by the command above, or `mkcert -CAROOT`) and install it:

```bash
./install-linux.sh trust-cert --ca /path/to/rootCA.pem
```

That writes into `~/.pki/nssdb`, which Chrome reads regardless of
`--user-data-dir` — so it survives the kiosk's throwaway profile. Finally point
the table at the HTTPS URL:

```bash
./install-linux.sh table --room A --server https://192.168.0.167:8443
```

`start-table.sh` drops the insecure-origin flag automatically when the server
URL is `https://`.

### When a table doesn't come up on its own

Autostart entries run when a **desktop session starts**, not when the machine
boots. If the table stops at the login screen, no session ever starts and
nothing launches — which looks identical to a broken autostart. Turn on
**Settings → Users → Unlock → Automatic Login**, or in `/etc/gdm3/custom.conf`
under `[daemon]`:

```
AutomaticLoginEnable=true
AutomaticLogin=your-table-user
```

Run the built-in diagnostic on the table PC to check that and everything else
(entry present and valid, exec bits, a browser on PATH, server reachable):

```bash
./install-linux.sh check-table
```

To rule the autostart wiring in or out, run the launcher by hand — if this
works but boot doesn't, it's the login/session problem above, not the script.
With no `ROOM`/`SERVER` in the environment it reads them from the installed
autostart entry, so a manual run targets the same server the table uses at
boot:

```bash
./start-table.sh
```

### Snap Chromium and the blank kiosk window

`sudo apt install chromium-browser` on Ubuntu installs the **snap**, which runs
under AppArmor confinement. It cannot write to `~/.config`, so the kiosk
profile fails to create and you get a blank window plus:

```
Failed To Create Data Directory - Chromium cannot read and write to its data directory
```

`start-table.sh` detects a snap browser (including the `/usr/bin/chromium`
wrapper script that quietly execs it) and moves the profile to
`~/snap/chromium/common/vstable/<room>`, which the snap can write.

The camera is a second hurdle — the snap needs the interface connected before
the table can send video to the other room:

```bash
sudo snap connect chromium:camera
```

For a table PC, the `.deb` build of Chrome sidesteps both:

```bash
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
```

```bash
sudo apt install -y ./google-chrome-stable_current_amd64.deb
```

`start-table.sh` prefers `google-chrome-stable` over Chromium, so nothing else
needs changing once it's installed.

To undo either:

```bash
sudo ./install-linux.sh uninstall-server
```

```bash
./install-linux.sh uninstall-table
```

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
| `table/` | the touchscreen UI and the nine mini-games | each table PC (browser) |
| `operator/` | GM dashboard for the VS layer | any browser |
| `wallplayer/` | **modified** Wall Player — adds a sabotage API | each projector PC |

`wallplayer/` is your existing Wall Player with three endpoints added. See
[wallplayer/CHANGES.md](wallplayer/CHANGES.md) for exactly what changed and how
to drop it in.

---

## Mini-games

Winning a sabotage means winning one of these first. The server deals a team a
random game from the pool and won't hand out the same one again until two
others have been played, so a team that keeps coming back gets variety rather
than the game they've gotten good at.

Every game is drawn procedurally — no image assets — so they scale from a
27-inch table to a 55-inch 4K one and stay in the room's accent colour.

| | Game | What you do | Win | Limit |
|---|---|---|---|---|
| 🚁 | **Flap Drone** | Tap anywhere to flap, gravity does the rest | Thread 8 laser gates without touching one | 90s |
| 🔴 | **Sequence** | Watch four panels light in order, tap them back | Survive 5 rounds, each one longer | 90s |
| 🏃 | **Corridor Run** | Tap the left or right half (or swipe) to change lane | Survive 30 seconds in the tunnel | 90s |
| 🔀 | **Reroute** | Drag between matching dots to link every pair | Link all pairs, no path crossing another | 90s |
| 🎯 | **Whack** | Tap green targets, never tap a red one | 12 hits — but 3 mistakes loses it | 60s |
| 🧠 | **Recall** | Flip two cards at a time to find matching pairs | All 8 pairs within 6 wrong guesses | 90s |
| ✂️ | **Cut The Line** | Swipe across a rope to sever it; gravity does the rest | Land the core in the collector 3 times — 5 drops loses | 90s |
| 🥊 | **Street Crew** | **1–4 players.** Tap a pad along the bottom to drop in; stick moves, HIT punches | Clear 3 waves and the brute on shared credits | 90s |
| 🪜 | **Scaffold** | **1–2 players.** Draw platforms under the auto-bouncing jumper; the angle you draw steers it | Reach the target altitude before the clock | 90s |

Lose, and the team waits 20 seconds before being dealt another. Win, and they
pick a sabotage to fire next door, then go on a two-minute cooldown.

**Speed Trap defusal.** When a team is hit with Speed Trap they get 30 seconds
to win a game or their clock runs at double speed for three minutes. Only
**Sequence** and **Whack** are offered there — they're the two that can
genuinely be finished inside 30 seconds by someone under pressure. Reroute
takes 30–60 seconds even for a player who has seen the board, so it's excluded
no matter how good a puzzle it is.

Which games are in the pool is `rules.minigames` in `config.json`; remove an id
to retire it. Tuning and how to add your own is in
[docs/MINIGAMES.md](docs/MINIGAMES.md).

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

## Settings screen

The operator dashboard has a **Settings** button linking to
`/operator/settings.html`. It edits the parts of `config.json` that are worth
changing between games:

- **Mini-games in the pool** — which games the server may deal
- **Rules** — cooldown, lockout, mini-game time limit, sabotage choice window,
  max sabotages per team, avoid-repeat count, and `armedOnly`
- **Difficulty** — easy / normal / hard, scaling every game's win and lose
  thresholds at once
- **Sabotages** — enable/disable each one, rename it, and edit its numeric
  parameters (durations, multipliers)

Changes apply **live** — the running engine reads the same config object, so
there is no restart — and are written back to `config.json`.

Two things it deliberately will not touch. **Hardware wiring** — light drivers
and device addresses, Wall Player URLs and tokens, Quandary room IDs — stays
hand-edited, because a dashboard that can break a hardware binding between two
games gives you a sabotage that silently does nothing and no clue why. And your
**`//` comments survive a save**: the screen re-reads `config.json` from disk
and edits that, rather than serialising the in-memory config, which has been
merged with defaults and had every documentation key stripped out.

The screen sits behind the same `operatorPin` as the rest of the dashboard, and
the dashboard carries the pin across in the link. Reaching it directly means
adding `?pin=…` yourself.

---

## Further reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces talk, and the state machine
- [docs/MINIGAMES.md](docs/MINIGAMES.md) — the nine games, difficulty tuning, and adding your own
- [docs/QUANDARYCONTROL.md](docs/QUANDARYCONTROL.md) — exactly how the bridge works, and how to drive VS from a puzzle
- [docs/HARDWARE.md](docs/HARDWARE.md) — lights, cameras, audio, projectors, network
- [docs/SABOTAGES.md](docs/SABOTAGES.md) — the catalog, tuning, and adding your own
