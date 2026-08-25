'use strict';

// Tiny console logger with a rolling in-memory buffer. The operator dashboard
// pulls the buffer so you can see what the VS layer did without RDP-ing into
// the server PC mid-game.

const BUFFER_MAX = 400;
const buffer = [];

function stamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function push(level, scope, msg, extra) {
  const entry = { t: Date.now(), level, scope, msg, extra: extra || null };
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.shift();
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  const line = `${stamp()} [${scope}] ${msg}${tail}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

function scoped(scope) {
  return {
    info: (msg, extra) => push('info', scope, msg, extra),
    warn: (msg, extra) => push('warn', scope, msg, extra),
    error: (msg, extra) => push('error', scope, msg, extra),
  };
}

function recent(sinceTs) {
  if (!sinceTs) return buffer.slice(-120);
  return buffer.filter(e => e.t > sinceTs);
}

module.exports = { scoped, recent };
