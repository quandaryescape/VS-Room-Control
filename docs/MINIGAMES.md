# Mini-games

Nine games. The server deals one at random when a team taps **PLAY FOR A
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
| `brawl` | Street Crew | 3 waves cleared | Shared credits exhausted | — |
| `scaffold` | Scaffold | Reach the target altitude | Clock only | — |

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

## Street Crew, the 1–4 player one

A side-scrolling beat-'em-up in the arcade-cabinet tradition. Up to four
players share the one table: each puts a finger on a free control island along
the bottom edge and is in. Clear three waves — two of goons, then a brute with
an escort — and the round is won.

### Drop-in, not a lobby

There is no ready-up screen. A team standing around a table does not all press
"ready" at the same moment, and waiting for them burns clock the round does not
have. Touching a free island joins you, mid-wave, at whatever point you arrive.
Nobody is ever removed, so a player who lets go still has a fighter standing.

### Shared credits, because a solo player exists

Each fighter has five health pips. Going down costs the **crew** one credit and
the fighter gets back up four seconds later; running out of credits ends the
round.

The obvious rule — "you are dead when your pips are gone" — reads fine with
four players and is brutal with one. A solo player would lose the instant their
last pip went, which makes the revive timer decorative and the game a single
five-mistake gauntlet. Credits start at 2 and **a joining player brings one
with them**, which is the coin slot: one player fights on 3, four on 6.

### Everything scales with the crew

Wave sizes are computed from the number of players who have actually joined,
and `rescaleWave()` tops a wave up when someone drops in mid-fight. One player
facing a four-player wave is not a challenge, it is a loss, and a team watching
one person lose learns nothing about the room. Reinforcements are always goons
even on the brute wave — a second brute arriving because a friend joined late
is a punishment, not a rebalance.

### Input: the one game that needs every finger

`onTap` and `onDrag` deliberately collapse to a single pointer, which is right
for the solo games and useless here. This game uses `api.onPointers`, added to
the engine for it, which reports every pointer keyed by `pointerId`. The game
layer also sets `touch-action: none` — under the page's `manipulation` a second
finger can become a browser gesture instead of a second player.

Islands are at **fixed positions** rather than "wherever you touch". Four people
reaching across one table need to know where their own controls are without
looking down, and an anchor-where-you-touch stick means two players fighting
over the same patch of glass.

Each island is a floating stick on the left and a HIT pad on the right. Holding
HIT keeps swinging at the cooldown rate, because that is what people do anyway.

### Reading a fight

Depth matters: a punch only connects if attacker and target are on roughly the
same line (`|Δz| < 0.14`), so stepping up or down the road is a real dodge.
Enemies telegraph with a 0.42s wind-up — the arm pulls back — and the blow only
lands if you are still in the line when it finishes. Cast is drawn sorted by
depth, so a fighter at the back never paints over one in front.

### The clock

The catalog gives this game `timeLimit: 120`, but that only applies if
`rules.minigameTimeLimitSeconds` is unset — the global override wins, and it
ships at 90. Three waves are tuned to be winnable inside 90 seconds by a crew
that keeps moving. If you want the fuller arcade pacing, either raise
`minigameTimeLimitSeconds` or clear it so per-game limits apply.

---

## Scaffold, and why the angle is the whole game

One or two players. The jumper bounces by itself on every landing; the drawer
draws the platforms it lands on. Reach the target altitude before the clock.
Solo, the drawer alone decides where it goes. A second player can tap the bar
at the bottom at any point to take the jumper, gaining steering and a charge
jump.

### The angle steers the jumper

A landing reflects the jumper's velocity about the drawn line's surface normal.
A flat platform sends it straight back up; a sloped one throws it sideways.

That one rule is the difference between a game and a chore. Without it, every
board has the same answer — draw a staircase — and the drawer is a bricklayer.
With it the drawer is *aiming*, and the solo mode stands up on its own instead
of being the two-player mode with a player missing.

Two clamps keep it playable:

```js
if (vy < MIN_BOUNCE * boost) vy = MIN_BOUNCE * boost;   // always real progress
vx = Math.max(-MAX_VX, Math.min(MAX_VX, vx));           // never uncatchable
```

Without the first, a shallow graze leaves the jumper dribbling in place.
Without the second, a steep line fires it across the screen faster than the
drawer can react — which reads as the game cheating rather than as a bad shot.

### Ink

Drawing spends a budget in proportion to line length, refilled at `INK_REGEN`
per second. This is what stops the staircase literally, and it is the number
that sets the whole pace of the game — tune it before anything else. Running
dry mid-stroke lays down whatever ink remains and ends the line there, rather
than silently discarding the rest of what the drawer was aiming.

### One-way platforms

Platforms are solid only while the jumper is falling, so a rising jumper passes
straight through whatever is being built above it. The test is the segment the
jumper's underside travelled this frame against the platform segment —
`api.segmentsCross`, shared with Cut The Line. When several cross in one frame
the highest wins, because falling means that is the one reached first.

### No death

Falling costs altitude and altitude costs time, which is pressure enough for a
90-second round. The clock is the only way to lose, as with Reroute. Ending the
round on one mistimed bounce would make the drawer's job feel punitive rather
than skilful, and in solo the drawer did not even throw the bounce.

### Layout and input

The control bar along the bottom is reserved from the start, even in solo play,
where it carries the "tap to take the jumper" prompt. Growing it on join would
resize the field underneath a drawer who is halfway through a stroke.

This game uses `api.onPointers` **exclusively**. `api.onDrag` binds its own
`pointerdown` on the same layer, so a game using both double-fires every touch.
Each pointer is routed on the way down — bar to the jumper, anything above it
to the drawer — which is what stops a second player's tap stealing a stroke in
progress.

### Difficulty

| | easy | normal | hard |
|---|---|---|---|
| Target altitude | 2200 | 3200 | 4400 |
| Ink capacity | 1500 | 1100 | 850 |
| Ink regen /s | 420 | 320 | 250 |
| Gravity | 1500 | 1750 | 2000 |
| Minimum bounce | 760 | 820 | 860 |

One world unit is one pixel, so altitude numbers can be sanity-checked against
bounce height directly: apex is `MIN_BOUNCE² / (2 · GRAVITY)`, about 190px on
normal, so the target is roughly seventeen good bounces.

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

## Difficulty

`rules.difficulty` is `easy`, `normal` or `hard`, set from the operator
Settings screen and applied without a restart. **`normal` is every game exactly
as it was tuned**, so the setting changes nothing until someone picks a
different level.

The mini-games run in the browser and cannot read the server's config, so the
value rides along in the room state snapshot and is handed to the game at
mount. A game asks for it through one helper:

```js
const TARGET = api.tune(6, 8, 11);   // easy, normal, hard
```

Stating the whole curve on one line is the point — a game's difficulty is
readable at a glance instead of scattered through branches. A game that has not
been tuned simply never calls it and behaves the same at every level.

| Game | Knob | easy · normal · hard |
|---|---|---|
| Flap Drone | gates to pass | 6 · 8 · 11 |
| Sequence | rounds to win | 4 · 5 · 7 |
| Corridor Run | seconds to survive | 22 · 30 · 42 |
| Whack | hits to win / mistakes allowed | 9·12·16 / 4·3·2 |
| Recall | wrong guesses allowed | 8 · 6 · 5 |
| Cut The Line | deliveries / drops allowed | 2·3·4 / 7·5·3 |
| Street Crew | see below | |

Reroute is the exception: its boards are baked in and screened for difficulty
when they are generated, so there is no single number to scale.

### Street Crew's curve

The brawler has the most to scale, and its constants sit together at the top of
`brawl.js`:

| | easy | normal | hard |
|---|---|---|---|
| Player health | 6 | 4 | 3 |
| Starting credits | 3 | 2 | 1 |
| Goon health | 2 | 2 | 3 |
| Brute health | 6 | 8 | 11 |
| Enemy wind-up | 0.52s | 0.38s | 0.28s |
| Gap between swings | 0.9–1.6s | 0.6–1.2s | 0.4–0.85s |
| Wave sizes | 2, 3, 1 | 3, 4, 1 | 4, 5, 2 |
| Extra bodies per player | 0.8 | 1.1 | 1.4 |

The **wind-up** is the one that matters most. It is the window in which
stepping off the enemy's depth line saves you, so shortening it is what turns
the fight from a stand-still-and-hold-HIT exercise into something that needs
footwork. `normal` is deliberately harder than the game's first cut for exactly
that reason.

The brute wave scales more gently per player than the goon waves: brutes soak
hits, so one extra brute adds far more time to a wave than one extra goon, and
the round is on a clock.
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
