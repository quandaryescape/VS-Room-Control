'use strict';

// The sabotage catalog.
//
// Each entry declares what hardware it needs; the server only offers a team the
// sabotages whose hardware is actually configured and reachable, so a room with
// no smart lights simply never shows "Kill The Lights" instead of firing a
// button that does nothing.
//
// execute() gets a context object and returns a descriptor:
//   { seconds, cancel() }  — cancel() is what "ALL STOP" and match-end call.

const log = require('./log').scoped('sabotage');

const CATALOG = [
  {
    id: 'blackout',
    label: 'Kill The Lights',
    blurb: 'Plunge them into darkness.',
    icon: '🌑',
    needs: ['lights'],
    defaults: { seconds: 20 },
    describe: c => `${c.seconds}s of darkness`,
    execute(ctx) {
      const seconds = ctx.params.seconds;
      const cancel = ctx.victim.lights.blackout(seconds);
      ctx.victim.wall.effect('blackout', { seconds });
      return {
        seconds,
        cancel() { cancel(); ctx.victim.wall.restore(); },
      };
    },
  },

  {
    id: 'strobe',
    label: 'Strobe',
    blurb: 'Flash their lights until they lose the plot.',
    icon: '⚡',
    needs: ['lights'],
    defaults: { seconds: 15, intervalMs: 700 },
    describe: c => `${c.seconds}s of strobing`,
    execute(ctx) {
      const { seconds, intervalMs } = ctx.params;
      const cancel = ctx.victim.lights.strobe(seconds, intervalMs);
      ctx.victim.wall.effect('flash', { seconds, intervalMs });
      return {
        seconds,
        cancel() { cancel(); ctx.victim.wall.restore(); },
      };
    },
  },

  {
    id: 'annoy',
    label: 'Annoying Noise',
    blurb: 'One horrible sound, straight into their room.',
    icon: '📢',
    needs: ['audio'],
    defaults: { seconds: 6 },
    describe: () => 'one very unwelcome noise',
    execute(ctx) {
      const sound = ctx.pickSound(ctx.params.soundId);
      if (!sound) return { seconds: 0, cancel() {} };
      ctx.toVictimTable('play_sound', { sound, volume: 1 });
      return { seconds: ctx.params.seconds, label: sound.label, cancel() {} };
    },
  },

  {
    id: 'soundboard',
    label: 'Soundboard',
    blurb: 'Open mic. Fire whatever you like into their room.',
    icon: '🎛️',
    needs: ['audio'],
    defaults: { seconds: 60 },
    describe: c => `${c.seconds}s of free rein`,
    execute(ctx) {
      const seconds = ctx.params.seconds;
      ctx.attackerRoom.soundboardUntil = Date.now() + seconds * 1000;
      ctx.engine.pushRoom(ctx.attackerRoom.key);
      const t = setTimeout(() => {
        ctx.attackerRoom.soundboardUntil = 0;
        ctx.engine.pushRoom(ctx.attackerRoom.key);
      }, seconds * 1000);
      return {
        seconds,
        cancel() {
          clearTimeout(t);
          ctx.attackerRoom.soundboardUntil = 0;
          ctx.engine.pushRoom(ctx.attackerRoom.key);
        },
      };
    },
  },

  {
    id: 'speedtrap',
    label: 'Speed Trap',
    blurb: 'Their clock doubles unless they defuse it in time.',
    icon: '⏩',
    needs: ['quandary'],
    defaults: { defuseSeconds: 30, penaltySeconds: 180, multiplier: 2 },
    describe: c => `defuse in ${c.defuseSeconds}s or run at ${c.multiplier}x`,
    execute(ctx) {
      const { defuseSeconds, penaltySeconds, multiplier } = ctx.params;
      return ctx.engine.startSpeedTrap(ctx.victimRoom.key, { defuseSeconds, penaltySeconds, multiplier });
    },
  },

  {
    id: 'lockout',
    label: 'Lockout',
    blurb: 'They cannot fight back for five minutes.',
    icon: '🔒',
    needs: [],
    defaults: { seconds: 300 },
    describe: c => `${Math.round(c.seconds / 60)} minute lockout`,
    execute(ctx) {
      const seconds = ctx.params.seconds;
      ctx.victimRoom.lockoutUntil = Date.now() + seconds * 1000;
      ctx.engine.pushRoom(ctx.victimRoom.key);
      return {
        seconds,
        cancel() {
          ctx.victimRoom.lockoutUntil = 0;
          ctx.engine.pushRoom(ctx.victimRoom.key);
        },
      };
    },
  },

  {
    id: 'takeover',
    label: 'Wall Takeover',
    blurb: 'Put your faces on all four of their walls.',
    icon: '📺',
    needs: ['wallplayer'],
    defaults: { seconds: 20, source: 'attacker' },
    describe: c => `${c.seconds}s of you, everywhere`,
    execute(ctx) {
      const seconds = ctx.params.seconds;

      // Whose camera goes on the walls. 'attacker' is the taunt — the other
      // team's faces surrounding you. 'victim' is the surveillance version:
      // the room watching itself on all four walls. Switch it in config.json.
      const sourceKey = ctx.params.source === 'victim'
        ? ctx.victimRoom.key
        : ctx.attackerRoom.key;

      // Used when there is no camera to be had.
      const fallback = () => {
        const file = ctx.victim.wall.randomSabotageVideo();
        if (file) {
          ctx.victim.wall.playAll(file, seconds);
        } else {
          ctx.victim.wall.effect('glitch', { seconds });
          ctx.victim.wall.message(ctx.params.text || 'SABOTAGED', Math.min(seconds, 8));
        }
      };

      return ctx.engine.startCamTakeover(sourceKey, ctx.victimRoom.key, seconds, fallback);
    },
  },

  {
    id: 'dimwalls',
    label: 'Dim The Walls',
    blurb: 'Drain the colour and light out of their projections.',
    icon: '🌫️',
    needs: ['wallplayer'],
    defaults: { seconds: 30 },
    describe: c => `${c.seconds}s of murk`,
    execute(ctx) {
      const seconds = ctx.params.seconds;
      ctx.victim.wall.effect('dim', { seconds, level: -70, desaturate: true });
      return { seconds, cancel() { ctx.victim.wall.restore(); } };
    },
  },

  {
    id: 'steal',
    label: 'Steal A Minute',
    blurb: 'Take a minute straight off their clock.',
    icon: '⏱️',
    needs: ['quandary'],
    defaults: { amountSeconds: 60 },
    describe: c => `-${c.amountSeconds}s, instantly`,
    execute(ctx) {
      ctx.engine.quandary.adjust(ctx.victimRoom.key, -Math.abs(ctx.params.amountSeconds));
      return { seconds: 0, cancel() {} };
    },
  },
];

const BY_ID = new Map(CATALOG.map(s => [s.id, s]));

function get(id) {
  return BY_ID.get(id) || null;
}

// Merge catalog defaults with the operator's config.json overrides.
function paramsFor(id, config) {
  const def = get(id);
  if (!def) return {};
  const override = (config.sabotages && config.sabotages[id]) || {};
  const params = Object.assign({}, def.defaults, override);
  delete params.enabled;
  delete params.label;
  return params;
}

function isEnabled(id, config) {
  const entry = (config.sabotages && config.sabotages[id]) || {};
  return entry.enabled !== false;
}

function labelFor(id, config) {
  const entry = (config.sabotages && config.sabotages[id]) || {};
  return entry.label || (get(id) ? get(id).label : id);
}

// The list a given attacker may actually see, filtered by config and by which
// hardware the victim room really has.
function availableFor(config, capabilities) {
  return CATALOG.filter(s => {
    if (!isEnabled(s.id, config)) return false;
    return s.needs.every(need => capabilities[need]);
  }).map(s => {
    const params = paramsFor(s.id, config);
    return {
      id: s.id,
      label: labelFor(s.id, config),
      blurb: s.blurb,
      icon: s.icon,
      detail: s.describe(params),
    };
  });
}

function run(id, ctx) {
  const def = get(id);
  if (!def) throw new Error(`Unknown sabotage "${id}"`);
  log.info(`Firing ${id}`, { from: ctx.attackerRoom.key, at: ctx.victimRoom.key, params: ctx.params });
  return def.execute(ctx);
}

module.exports = { CATALOG, get, run, paramsFor, isEnabled, labelFor, availableFor };
