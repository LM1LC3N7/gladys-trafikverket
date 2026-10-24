// -----------------------------------------------------------------------------
// Endpoint, limits, pacing and the keys users store (manifest keys, device
// type, feature keys): the keys are forever, never rename them.
// -----------------------------------------------------------------------------

/**
 * The official open API of Trafikverket (data.trafikverket.se). The request
 * is the XML query of the API (the key travels in its body, never in the
 * URL); the answer is asked in JSON (`data.json`), parsed by JSON.parse
 * (linear, no XML parser on a hostile answer).
 */
export const API_URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';

/** The object read, and its schema version (as pytrafikverket asks it). */
export const OBJECT_TYPE = 'WeatherMeasurepoint';
export const SCHEMA_VERSION = '2.1';

export const USER_AGENT = 'gladys-trafikverket (+https://github.com/LM1LC3N7/gladys-trafikverket)';

/** One HTTP call, the body read included. */
export const HTTP_TIMEOUT = 15_000;

/** The most an answer may weigh (a few KB per station). */
export const MAX_BODY = 256 * 1024;

/** At most this many stations configured (manifest fields `station_<n>`). */
export const MAX_STATIONS = 5;

/** At most this many records of the answer are looked at. */
export const MAX_RECORDS = 50;

/** How often the integration checks what is due. */
export const TICK = 15_000;

/**
 * The state file under /data is written at most once per minute (flash
 * memory, restart loops): a read waits for that too.
 */
export const WRITE_GAP = 60_000;

/**
 * 429 / 5xx: a pause, from Retry-After when given, else 5 minutes doubling;
 * always between 1 minute and 6 hours.
 */
export const BUSY_MIN = 60_000;
export const BUSY_BASE = 5 * 60_000;
export const BUSY_MAX = 6 * 60 * 60_000;

/**
 * A new key is tried this long after the last request at the earliest (the
 * interval is kept for anything else).
 */
export const NEW_KEY_GAP = 60_000;

/**
 * A measurement older than this (or than 2 intervals, whichever is longer,
 * never more than STALE_MAX) is never published.
 */
export const STALE = 60 * 60_000;
export const STALE_MAX = 2 * 60 * 60_000;

/**
 * A measurement dated this far after the clock of the service is not
 * trusted (never "fresher than now").
 */
export const FUTURE_SLACK = 10 * 60_000;

/** The test button answers within this, with the last values if needed. */
export const TEST_DEADLINE = 60_000;

/** Where the pace, the pause, the refusal and the last measurements survive a restart. */
export const STATE_FILE = '/data/trafikverket-state.json';

/** Device type of the external ids (`ext:<selector>:station:<station id>`). */
export const DEVICE_TYPE = 'station';

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};
