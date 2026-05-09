// =============================================================================
// LOGGER — Structured Console Logging dengan Timestamp & Warna
// =============================================================================

const { LOG } = require('./config');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG.LEVEL] ?? LEVELS.info;

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function timestamp() {
  return new Date().toLocaleTimeString('id-ID', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatMsg(level, tag, message) {
  const ts = `${COLORS.dim}[${timestamp()}]${COLORS.reset}`;
  const colorMap = {
    debug: COLORS.cyan,
    info: COLORS.green,
    warn: COLORS.yellow,
    error: COLORS.red,
  };
  const color = colorMap[level] || COLORS.reset;
  const lvl = `${color}${level.toUpperCase().padEnd(5)}${COLORS.reset}`;
  const tagStr = tag ? `${COLORS.blue}[${tag}]${COLORS.reset} ` : '';
  return `${ts} ${lvl} ${tagStr}${message}`;
}

/**
 * Membuat logger instance untuk modul tertentu.
 * @param {string} tag - Nama modul (misal: 'AUTH', 'WS', 'ANALYTICS')
 * @returns {Object} Logger object dengan method debug/info/warn/error
 */
function createLogger(tag) {
  return {
    debug: (msg, ...args) => {
      if (currentLevel <= LEVELS.debug)
        console.log(formatMsg('debug', tag, msg), ...args);
    },
    info: (msg, ...args) => {
      if (currentLevel <= LEVELS.info)
        console.log(formatMsg('info', tag, msg), ...args);
    },
    warn: (msg, ...args) => {
      if (currentLevel <= LEVELS.warn)
        console.warn(formatMsg('warn', tag, msg), ...args);
    },
    error: (msg, ...args) => {
      if (currentLevel <= LEVELS.error)
        console.error(formatMsg('error', tag, msg), ...args);
    },
  };
}

module.exports = { createLogger };
