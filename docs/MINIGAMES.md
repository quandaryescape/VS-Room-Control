# Mini-games

Seven games. The server deals one at random when a team taps **PLAY FOR A
SABOTAGE**, avoiding whatever they were given in the last couple of rounds.

| id | Name | Win condition | Lose condition | Defuse? |
|---|---|---|---|---|
| `flappy` | Flap Drone | Pass 8 gates | Touch anything | — |
| `simon` | Sequence | 5 rounds of pattern | One wrong pad | ✓ |
| `runner` | Corridor Run | Survive 30s | Hit an obstacle | — |
| `flow` | Reroute | Link all pairs without crossing | Clock only | — |
| `reaction` | Whack | 12 green targets | 3 red targets | ✓ |
| `memory` | Recall | 8 pairs | 6 wrong guesses | — |
| `cutrope` | Cut The Line | 3 cores delivered | 5 drops | — |

"Defuse?" marks the games eligible for the Speed Trap's defuse challenge, where
a team has 30 seconds and is panicking. That is a tighter bar than it looks, so
it was measured rather than guessed:

| Game | Fastest possible | Under pressure | Fits 30s? |
|---|---|---|---|
| Whack | ~12s | ~18s | comfortably |
| Sequence | ~18s | ~22s | yes, tensely |
| Reroute | ~25s | 50s+ | **no** |

Sequence is gated by its own playback animation, so ~18s is a hard floor no
matter how fast the players are — it fits, but only just, which is exactly the
feeling a defuse should have. Reroute is a good puzzle and a bad defuse: even
someone who has seen the board needs longer than the window, so it is excluded.
If you add a game and want it in the defuse pool, time its floor first.

Change the pool in `config.json`:

```json
"rules": { "minigames": ["flappy", "simon", "runner", "flow", "reaction", "memory"] }
```

Remove an id to retire a game. Set `minigameTimeLimitSeconds` for the overall
round clock (default 90).

---

## Reroute, and why the puzzles are baked in

Reroute is Numberlink — link every pair of matching dots, and no path may cross
another. **You do not have to fill the board**; linking every pair is the whole
win condition. Drag from a dot to draw, drag back along your own line to retract
it, drag through someone else's line to cut it.

The 22 puzzles are pre-generated and embedded in `table/games/flow.js` rather
than generated at runtime. That is deliberate: generating Numberlink boards in
the browser risks handing a team an unsolvable board in the middle of a live
game, and there is no way to recover from that in front of customers.

Sizes are 5×5 with 4–5 pairs, 6×6 with 5–6 pairs, and 7×7 with 6 pairs.

### How they are made and checked

1. Lay a random Hamiltonian path over the grid and cut it into coloured
   segments. That guarantees a *full-coverage* solution exists — and since the
   game only asks for linking, which is strictly weaker, a valid solution is
   guaranteed either way.
2. **Screen for difficulty** (see below).
3. **Independently re-solve from scratch** with a separate solver that knows
   nothing about how the board was built.
4. Play every board to a win through the real game UI.

### The difficulty screen

Dropping the fill requirement makes boards much easier, and a first pass of 18
puzzles turned out to be a formality: **10 of them could be cleared just by
drawing each pair along its shortest free path**, in essentially any order. That
is the same "no thinking required" problem that got the previous wire-matching
game cut.

So every candidate is now scored by how often that lazy approach succeeds over
120 random pair orderings, and a board is only kept if it fails **at least ~45%
of the time**. The shipped set ranges from 11% to 53% lazy-solve rate, so a
careless order will usually paint you into a corner and force a re-route —
which is the part that actually feels like a puzzle.

The generator and the difficulty scorer are not shipped in the repo; if you want
to regenerate the set, the method above is enough to rebuild them. Whatever you
do, **verify before shipping** — an unsolvable board in front of paying
customers is not recoverable.

The encoding is `"WH"` followed by four digits per pair — `ax ay bx by`:

```
'553321311000243440'
 ││└─ pair 1: (3,3)-(2,1)
 │└── height 5
 └─── width 5
```

Grids are capped at 9×9 by the single-digit encoding, which is well past what
is playable on a table under a 90-second clock.

---

## Cut The Line, and why the rope is not a rope

A Cut the Rope clone. The core hangs from one or more ropes; swipe across a
rope to sever it; whatever swing has been built up decides where it lands. Land
three cores in the collector to win. Five drops and the round is lost.

### One particle, not a chain

The obvious way to build this is a chain of rope segments with the core on the
end. Don't. A segmented rope carrying a heavy mass is a spring, and it needs a
lot of solver iterations per frame before it stops behaving like one — get it
wrong and the core is flung off the top of the screen, which is not a thing
anyone wants to explain to a team mid-game.

Instead the core is a single verlet particle, and each rope is a *maximum
distance constraint* back to its anchor:

```js
if (dist > len) {           // taut — pull the core back onto the circle
  pos.x = ax + (dx / dist) * len;
  pos.y = ay + (dy / dist) * len;
}                           // slack — the rope does nothing at all
```

That is the entire rope model, and it is unconditionally stable: a constraint
can only ever move the core *closer* to where it should be. Six passes are
enough for two ropes to settle against each other rather than fight. Because
verlet infers velocity from the gap between positions, a constraint that moves
the core also correctly changes its speed — the pendulum swing comes out for
free rather than being animated.

The rope is *drawn* with a sag proportional to its slack, so a taut rope reads
as a straight line under tension and a slack one visibly droops. That is the
only cue a player needs to see which rope is currently carrying the core.

### Cutting tests the segment, not the point

A fast swipe on a 4K table moves hundreds of pixels between pointer events. A
cut that asks "is the finger on a rope right now" misses almost every fast
swipe, and a fast swipe is exactly what a player under time pressure does. So
each move event tests the **segment the finger just travelled** against the
rope, with a standard segment-intersection test.

### The levels are hand-authored, for the same reason Reroute's are

An unsolvable physics layout is not recoverable in front of customers, and
unlike Numberlink there is no cheap solver to verify a random one. So the
layouts are written by hand under two rules:

- the collector sits inside the arc the core can actually reach, so cutting at
  the right moment always works;
- bumpers only ever deflect. None of them forms a concave pocket that could
  trap the core, and a contact applies a small sideways jitter so the core
  cannot balance on the exact top of one.

The three levels teach, then test: a single rope straight above the collector,
then two ropes with the collector off to one side, then the same mirrored with
a bumper that punishes dropping it straight down and hoping.

### Why it is not a defuse game

A Speed Trap defuse has to be winnable in 30 seconds by someone panicking.
Cut The Line asks for three separate deliveries, each needing a swing to build
before the cut is worth making, so it is `defuse: false`. If you want a
shorter variant for defusal, drop `DELIVERIES_TO_WIN` to 1 and time the floor
before changing the flag — see the table at the top of this file.

---

## Tuning difficulty

Most games have their thresholds as named constants at the top of their file
(`TARGET`, `SURVIVE`, `ROUNDS_TO_WIN`, `TARGET_HITS`, `MAX_MISSES`). They are
deliberately not in `config.json` — they interact with the game's own pacing,
so they want changing with the code in front of you.

### The one that needed measuring: Recall

Recall's miss limit was set by simulation rather than by feel, because the
intuitive number is wrong. Simulating an optimal player over 30,000 games:

| Player | Mean wrong guesses | Win rate at 5 | Win rate at 6 | Win rate at 7 |
|---|---|---|---|---|
| Perfect memory | 4.4 | 55% | ~85% | ~97% |
| Good (85% recall) | 5.0 | 30% | **70%** | 92% |
| Average (65% recall) | 6.3 | 11% | ~45% | ~70% |

A limit of 5 would fail even a flawless player half the time. The shipped limit
is **6**: a good team clears it about 70% of the time, a careless one does not,
and nobody can brute-force the board by flipping all sixteen cards — that alone
costs more than six wrong guesses.

If you want Recall easier, raise `MAX_MISSES` to 7 before you reduce the number
of pairs; the eight-pair board is what makes it feel like a real memory test.

---

## Adding a game

Drop a file in `table/games/`, register it, and add a `<script>` tag to
`table/index.html` plus an entry in `server/lib/minigames.js`.

```js
VSGames.register({
  id: 'mygame',
  name: 'My Game',
  howto: 'One sentence a panicking player can read in two seconds.',

  mount(api) {
    const { g } = api.makeCanvas();     // or append DOM to api.layer
    api.progress('0 / 5');              // shows in the HUD
    api.onTap(pt => { /* ... */ });
    api.onFrame(dt => { /* draw */ });
    // api.win() / api.lose('reason')
  },
});
```

The harness gives you `makeCanvas()`, `el()`, `onTap`, `onDrag`, `onLane`
(tap-left/tap-right/swipe), `onFrame`, `after`, `every`, `rand`, `randInt`,
`beep`, `progress`, `win`, `lose`, and cleans all of it up on `destroy()` — which
matters, because a Speed Trap can interrupt any game mid-round.

Two rules worth honouring:

- **Readable at a glance, winnable in 60 seconds.** Players are already under a
  clock and in a dark room.
- **Never require precision the touchscreen can't deliver.** Big targets. The
  table may be a 55-inch panel with a fingerprint-smeared surface.
