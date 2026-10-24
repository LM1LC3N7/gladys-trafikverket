// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized so
// the rest of the code never deals with strings or `undefined`.
// -----------------------------------------------------------------------------

import { MAX_STATIONS } from './constants.js';
import { isUnsafeChar } from './trafikverket.js';

// Defaults: they MUST match the `default` values of the manifest
// (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  poll_interval: 10,
};

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 60;

/** A number typed by the user; '' and null are "not set", never 0. */
const number = (value, fallback, min, max) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(max, Math.max(min, Math.round(value)));
  }
  if (typeof value === 'string' && /^\s*\d{1,6}\s*$/.test(value)) {
    return Math.min(max, Math.max(min, Number(value)));
  }
  return fallback;
};

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * A key of the open API of Trafikverket: letters, digits, `-` and `_` only
 * (the keys the portal gives are 32 hexadecimal digits). Anything else (a
 * line break, a space, a `<`) is refused at once and never sent.
 */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * A character never sent in a station name: controls, bidirectional
 * controls, line separators, a lone surrogate, the non-characters XML 1.0
 * forbids (isUnsafeChar). One of them would make the service refuse the
 * whole query: the entry is refused alone, by its number.
 */
const hasControl = (text) => !text.isWellFormed() || [...text].some(isUnsafeChar);

/** The longest station name or id accepted. */
const MAX_NAME = 80;

/**
 * `api_key`: the key (secret). `station_<n>`: the name of a road weather
 * station as Trafikverket writes it ("Kungälv", ...), or its id
 * ("SE_STA_VVIS..."). A bad or repeated entry is reported by its number
 * only, never echoed (a key may have been pasted into the wrong field).
 */
export function normalizeConfig(raw = {}) {
  const stations = [];
  const invalid = [];
  const seen = new Set();
  for (let n = 1; n <= MAX_STATIONS; n += 1) {
    const text = clean(raw[`station_${n}`]).normalize('NFC');
    if (!text) {
      continue;
    }
    if (text.length > MAX_NAME || hasControl(text)) {
      invalid.push({ slot: n, why: 'station' });
      continue;
    }
    const folded = text.toLowerCase();
    if (seen.has(folded)) {
      invalid.push({ slot: n, why: 'duplicate' });
      continue;
    }
    seen.add(folded);
    stations.push({ slot: n, query: text });
  }
  const apiKey = clean(raw.api_key);
  return {
    apiKey,
    keyInvalid: apiKey !== '' && !KEY_PATTERN.test(apiKey),
    stations,
    invalid,
    pollMinutes: number(
      raw.poll_interval,
      DEFAULT_CONFIG.poll_interval,
      MIN_INTERVAL,
      MAX_INTERVAL,
    ),
  };
}

/** A key that may be sent, and at least one station. */
export const isReady = (config) =>
  config.apiKey !== '' && !config.keyInvalid && config.stations.length > 0;
