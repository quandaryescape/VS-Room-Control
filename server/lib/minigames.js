'use strict';

// Server-side view of the mini-games. The games themselves live in
// /table/games and run on the touchscreen; the server owns which game a team
// gets, how long they have, and whether a "win" is allowed to count.
//
// `defuse` marks games that fit inside a Speed Trap's 30-second window while
// the victims are panicking. It is a tighter bar than it looks:
//   Sequence  ~18s played perfectly, ~22s with normal hesitation - tense, fits.
//   Whack     ~12-18s - comfortable.
//   Reroute   30-60s even for someone who has seen the board - does NOT fit,
//             so it is excluded no matter how good a puzzle it is.
// If you add a game here, time its floor before setting defuse: true.

const crypto = require('crypto');

const CATALOG = [
  { id: 'flappy',   name: 'Flap Drone',   blurb: 'Tap to fly. Thread eight gates.',            timeLimit: 90, defuse: false },
  { id: 'simon',    name: 'Sequence',     blurb: 'Watch the pattern. Repeat it back.',         timeLimit: 90, defuse: true },
  { id: 'runner',   name: 'Corridor Run', blurb: 'Three lanes. Do not hit anything.',          timeLimit: 90, defuse: false },
  { id: 'flow',     name: 'Reroute',      blurb: 'Link every pair without crossing a line.',   timeLimit: 90, defuse: false },
  { id: 'reaction', name: 'Whack',        blurb: 'Hit the live targets. Miss the dead ones.',  timeLimit: 60, defuse: true },
  { id: 'memory',   name: 'Recall',       blurb: 'Eight pairs, six wrong guesses.',              timeLimit: 90, defuse: false },
  { id: 'cutrope',  name: 'Cut The Line', blurb: 'Swipe to cut. Drop the core in.',           timeLimit: 90, defuse: false },
];

const BY_ID = new Map(CATALOG.map(g => [g.id, g]));

function get(id) {
  return BY_ID.get(id) || null;
}

// Random pick that avoids handing the same team the same game twice in a row.
function pick(pool, recent, avoidCount) {
  const usable = pool.filter(id => BY_ID.has(id));
  if (!usable.length) return null;
  const avoid = new Set((recent || []).slice(-Math.max(0, avoidCount || 0)));
  let candidates = usable.filter(id => !avoid.has(id));
  if (!candidates.length) candidates = usable;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function pickDefuse(pool) {
  const usable = (pool || []).filter(id => BY_ID.has(id) && BY_ID.get(id).defuse);
  const list = usable.length ? usable : CATALOG.filter(g => g.defuse).map(g => g.id);
  return list[Math.floor(Math.random() * list.length)];
}

function newToken() {
  return crypto.randomBytes(9).toString('base64url');
}

module.exports = { CATALOG, get, pick, pickDefuse, newToken };
