// -----------------------------------------------------------------------------
// Fakes for the tests: fetch (routes requests to handlers, records every call,
// fails loudly on an unexpected URL), Trafikverket answers (the JSON form of
// a `WeatherMeasurepoint` 2.1 answer, with the paths pytrafikverket reads),
// a client of the app, timers (nothing fires by itself) and a logger that
// keeps every line. No test touches the network nor the disk.
// -----------------------------------------------------------------------------

import { setFetch } from '../../src/http.js';

setFetch(async (url) => {
  throw new Error(`Network call without a fake fetch in a test: ${url}`);
});

export const API_KEY = '0123456789abcdef0123456789abcdef';
export const OTHER_KEY = 'fedcba9876543210fedcba9876543210';

/** 2026-10-24 12:00:00 UTC (14:00 in Stockholm). */
export const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

/** "2026-10-24T13:50:00.000+02:00" for an instant (ms), in Stockholm summer time. */
export const sampleText = (ms) => {
  const local = new Date(ms + 2 * 3_600_000).toISOString().slice(0, 23);
  return `${local}+02:00`;
};

/** One WeatherMeasurepoint record. */
export const record = ({
  id = 'SE_STA_VVIS1001',
  name = 'Kungälv',
  sampleAt = NOW - 10 * 60_000,
  sample,
  air = 6.4,
  road = 3.1,
  ice = false,
  wind = [{ Speed: { Value: 4.2 }, Direction: { Value: 225 } }],
  extra = {},
} = {}) => ({
  Id: id,
  Name: name,
  Observation: {
    Sample: sample ?? sampleText(sampleAt),
    Air: {
      Temperature: { Value: air },
      RelativeHumidity: { Value: 87.5 },
      Dewpoint: { Value: 4.4 },
    },
    Wind: wind,
    Aggregated30minutes: {
      Wind: { SpeedMax: { Value: 9.8 } },
      Precipitation: { TotalWaterEquivalent: { Value: 0.6 }, Rain: true, Snow: false },
    },
    Surface: {
      Temperature: { Value: road },
      Ice: ice,
      IceDepth: { Value: 0 },
      Snow: false,
      Water: true,
      WaterDepth: { Value: 0.2 },
    },
    ...extra,
  },
});

/** The JSON answer of data.json. */
export const answer = (records) => ({
  RESPONSE: { RESULT: [{ WeatherMeasurepoint: records }] },
});

export const errorAnswer = (source = 'Authentication', message = 'Invalid key') => ({
  RESPONSE: { RESULT: [{ ERROR: { SOURCE: source, MESSAGE: message } }] },
});

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Install a fake fetch; `routes` is a list of [RegExp, handler(call)]. */
export function installFetch(routes) {
  const calls = [];
  const previous = setFetch(async (url, init = {}) => {
    const call = { url, init };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) {
      throw new Error(`Unexpected network call in a test: ${url}`);
    }
    return route[1](call);
  });
  return { calls, restore: () => setFetch(previous) };
}

export function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const add = (kind, fn, ms) => {
    const id = nextId++;
    pending.set(id, { id, kind, fn, ms });
    return id;
  };
  return {
    pending,
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    intervals: () => [...pending.values()].filter((t) => t.kind === 'interval'),
    async runIntervals() {
      for (const t of [...pending.values()].filter((t) => t.kind === 'interval')) {
        await t.fn();
      }
    },
    async runTimeouts() {
      for (const t of [...pending.values()].filter((t) => t.kind === 'timeout')) {
        pending.delete(t.id);
        await t.fn();
      }
    },
  };
}

/** A logger that keeps every line, to check that no secret reaches it. */
export function recordingLogger() {
  const lines = [];
  const keep =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => String(a?.message ?? a)).join(' ')}`);
  return {
    lines,
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    debug: keep('debug'),
  };
}

/** A clock the tests move (wall and monotonic together). */
export function createClock(start = NOW) {
  let wall = start;
  let mono = 1_000_000;
  return {
    now: () => wall,
    monotonic: () => mono,
    advance(ms) {
      wall += ms;
      mono += ms;
    },
    /** The wall clock jumps (NTP, a wrong RTC), the monotonic one does not. */
    jump(ms) {
      wall += ms;
    },
  };
}
