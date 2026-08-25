# Sabotages

## The catalog

Every sabotage declares the hardware it needs. The server only offers a team the
sabotages the *target room* can actually receive, so an unconfigured light
switch means "Kill The Lights" is never shown rather than shown and dead.

| id | Label | Needs | Default | What happens |
|---|---|---|---|---|
| `blackout` | Kill The Lights | lights | 20s | Lights off; walls go black too. Both restore on a timer. |
| `strobe` | Strobe | lights | 15s | Lights flash; walls flash in sympathy. |
| `annoy` | Annoying Noise | table speakers | one shot | A random sound from your list plays in the victim's room. |
| `soundboard` | Soundboard | table speakers | 60s | The *attacker's* table grows a soundboard; every button fires into the victim's room. |
| `speedtrap` | Speed Trap | Quandary | 30s / 3 min | Victim's table is taken over by a defuse challenge. Beat it and nothing happens; miss it and their clock runs at 2x for three minutes. |
| `lockout` | Lockout | — | 5 min | The victim cannot earn or fire sabotages. |
| `takeover` | Wall Takeover | Wall Player | 20s | The saboteurs' own camera goes live on all four of the victim's walls. Falls back to a clip or a glitch pass if no camera is available. |
| `dimwalls` | Dim The Walls | Wall Player | 30s | Projections drained of light and colour. |
| `steal` | Steal A Minute | Quandary | 60s | A minute comes straight off the victim's clock, instantly. |

## Tuning

All of it is in `config.json` under `sabotages`. Change a duration, rename a
sabotage for your theme, or switch one off:

```json
"sabotages": {
  "blackout": { "enabled": true, "seconds": 30, "label": "Lights Out" },
  "strobe":   { "enabled": false },
  "speedtrap": {
    "enabled": true,
    "defuseSeconds": 30,
    "penaltySeconds": 180,
    "multiplier": 2
  }
}
```

`label` is what players see, so re-theme freely — "Kill The Lights" can become
"Cut The Power" without touching code.

### Pacing

The knobs that actually control how hectic a game feels are in `rules`:

| Setting | Default | Effect |
|---|---|---|
| `cooldownSeconds` | 120 | Time between one sabotage and the next chance to earn one. The single biggest pacing control. |
| `minigameTimeLimitSeconds` | 90 | How long a team has to win their challenge. |
| `sabotageChoiceSeconds` | 45 | How long the sabotage menu stays open. Letting it lapse burns the earned sabotage, so teams can't bank one. |
| `maxSabotagesPerTeam` | 0 | Hard cap per team per match. 0 is unlimited. |
| `armedOnly` | true | Whether sabotage requires the GM (or a puzzle) to arm the round. |

Two rules of thumb from how the loop actually plays:

- **A 60-minute game with a 120s cooldown** gives a competent team roughly 12–15
  sabotage attempts. That is already a lot of interruption. Start at 180s if
  your room is puzzle-dense and you want the escape room to stay the main event.
- **Losing a mini-game costs only 20 seconds**, not the full cooldown. That is
  deliberate — failing should send them straight back to try again, since the
  punishment for losing is the time they wasted, not a lockout.

## How the Wall Takeover plays

This one puts a live camera feed on the victim's projectors, so it is worth
knowing how it is wired:

1. Room A fires it at Room B.
2. Room A's table starts grabbing frames from its own USB camera and posting
   them to the VS server (12fps, 960px wide) — an **ON THEIR WALLS** badge
   appears on Room A's table so they know it is landing.
3. The VS server republishes those frames as a standard MJPEG stream.
4. All four of Room B's projectors open that stream like any other file, with
   `LIVE` buffering so the walls stay in step with the room rather than a
   minute behind.
5. After the window closes, the walls return to the shuffle and the relay
   buffer is dropped.

**Whose camera?** By default the *attacker's* — the other team's faces
surrounding you, which is the taunt. Set `"source": "victim"` on the sabotage
in `config.json` for the surveillance version instead, where the room watches
itself on all four walls.

```json
"takeover": { "enabled": true, "seconds": 20, "source": "victim" }
```

If the attacking table has no working camera, no frames arrive within three
seconds and it falls back to a takeover clip, or to a glitch pass plus large
text. The sabotage always does something visible.

## How the Speed Trap plays

This is the only sabotage that both rooms participate in, so it is worth
understanding:

1. Room A fires it at Room B.
2. Room B's table is taken over — whatever they were doing is cancelled — and
   replaced by a full-screen red **DEFUSE NOW** panel with a countdown and a
   short challenge (Sequence or Whack — see
   [MINIGAMES.md](MINIGAMES.md) for why only those two).
3. If they beat it in time: nothing happens, and Room A is told they defused it.
4. If they don't: their Quandary clock runs at 2x for three minutes, the walls
   flash `CLOCK x2`, and Room A is told it landed.

Failing an attempt does not end it — they can keep trying until the countdown
expires, which is what keeps the panic going.

## Adding your own

`server/lib/sabotages.js` is a plain array. An entry needs metadata for the UI
and an `execute()` that returns how long it lasts and how to cancel it:

```js
{
  id: 'fog',
  label: 'Fog Burst',
  blurb: 'Fill their room with fog.',
  icon: '💨',
  needs: ['lights'],            // gates on configured hardware
  defaults: { seconds: 10 },
  describe: c => `${c.seconds}s of fog`,

  execute(ctx) {
    const seconds = ctx.params.seconds;
    ctx.victim.lights.setPower(true);          // or your own adapter
    const t = setTimeout(() => {/* stop */}, seconds * 1000);
    return { seconds, cancel() { clearTimeout(t); /* stop */ } };
  },
}
```

**Always return a working `cancel()`.** It is what ALL STOP, ending the match,
and shutting down the server call. Anything that can leave a room in a bad state
must be undoable from one button.

The `ctx` you get:

| | |
|---|---|
| `ctx.params` | catalog defaults merged with `config.json` overrides |
| `ctx.victimRoom` / `ctx.attackerRoom` | room state objects |
| `ctx.victim.lights` / `ctx.victim.wall` | the target room's hardware adapters |
| `ctx.pickSound(id)` | a sound from the configured list, random if `id` is omitted |
| `ctx.toVictimTable(event, payload)` | push a socket event to the victim's table |
| `ctx.engine` | the engine, for cross-room state like lockouts |

Add the id to `config.json` under `sabotages` to enable it.
