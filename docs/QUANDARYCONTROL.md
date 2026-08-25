# Quandary Control integration

**Quandary Control is not modified.** Nothing in this project writes to its
source, its database, or its config. The bridge uses only the interfaces
Quandary already exposes to any GM screen or hardware integration, so a
Quandary upgrade should not break it.

## What the bridge does

`server/adapters/quandary.js` opens one Socket.IO connection per room and joins
as an ordinary GM client:

```js
socket.emit('join_room', { roomId, clientType: 'gm' });
```

From there:

| Purpose | Mechanism |
|---|---|
| Show the real countdown on the table | listens for `timer_update` |
| **Steal A Minute** | `timer_control` `{ action: 'adjust', amount: -60 }` |
| **Speed Trap** | `timer_control` adjust `-1` once per second |
| Warn the victim on their player screen | `sendHint` |
| Publish VS state to the GM | `POST /api/v1/rooms/:id/variables` |

### Why the Speed Trap works the way it does

Quandary's `TimerService` derives `remaining` from wall-clock elapsed time:

```js
const elapsed = Math.floor((Date.now() - timer.startTime) / 1000);
timer.remaining = Math.max(timer.duration - elapsed, 0);
```

There is no speed multiplier to set. But subtracting one second from `duration`
once per second makes the visible clock fall twice as fast; subtracting two
makes it fall three times as fast. That is exactly what the sabotage is meant to
do, and it uses a documented control path rather than reaching into internals.

**Side effect worth knowing:** the room's *total* duration shrinks along with
the remaining time, so a 60-minute game that took a full Speed Trap ends up
showing a 57-minute total on the GM screen. The players only ever see the
countdown, but do not be surprised by it in the GM view or in post-game stats.

## Variables published back into Quandary

The VS server writes these into each room, so they show on the GM screen and
can drive Quandary's own trigger/action system:

| Variable | Type | Meaning |
|---|---|---|
| `vs_sabotages_used` | integer | how many sabotages that team has landed |
| `vs_locked_out` | boolean | that team is currently locked out |

## Driving the VS layer from a puzzle

Quandary's legacy trigger system includes a `send_webhook` action. Point it at
the VS server to let something physical in the room control the match:

| URL | Effect |
|---|---|
| `POST http://<vs>:8990/api/hook/arm` | arm the match (sabotages become available) |
| `POST http://<vs>:8990/api/hook/disarm` | end the match and restore both rooms |
| `POST http://<vs>:8990/api/hook/allstop` | cancel every running effect |
| `POST http://<vs>:8990/api/hook/fire?to=B&sabotage=blackout` | fire a specific sabotage |
| `POST http://<vs>:8990/api/hook/grant?room=A` | hand a team a free sabotage pick |

Both query strings and JSON bodies work, so they fit whatever shape Quandary's
webhook action sends.

A worked example — arm the VS round when the team opens the first lock, by
adding this to the room's `config.triggers`:

```json
{
  "variable": "first_lock_opened",
  "condition": "equals",
  "value": "true",
  "actions": [
    { "type": "send_webhook", "url": "http://192.168.1.20:8990/api/hook/arm" }
  ]
}
```

And `grant` is the interesting one: wire it to a physical puzzle and solving
that puzzle hands the team a sabotage without them having to play a mini-game
for it.

## Finding your room IDs

```bash
curl http://127.0.0.1:3000/api/v1/rooms
```

Copy the `id` of each room into `rooms.A.quandaryRoomId` and
`rooms.B.quandaryRoomId`. The operator dashboard's **Probe hardware** button
confirms both rooms are linked and shows the live timer it is reading.

## If Quandary is down

The bridge reconnects on its own every couple of seconds. While it is
disconnected:

- tables show `--:--` instead of a countdown,
- **Speed Trap** and **Steal A Minute** are not offered to players, because the
  sabotage menu is filtered by what the target room can actually receive,
- everything else — lights, sound, walls, lockouts — keeps working.
