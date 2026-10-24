// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Trafikverket: the
// devices and states, the pace (never faster than the interval: test button,
// reconnection, saved configuration, restart), the state file (written at
// most once per minute, never the key), the final refusal of a key, the
// pauses, late answers, and the freshness of the measurements (an old one is
// never published again as a new one, even after a restart).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TrafikverketApp } from '../src/app.js';
import { BUSY_MAX, TICK } from '../src/constants.js';
import { memoryStorage } from '../src/store.js';
import {
  API_KEY,
  NOW,
  OTHER_KEY,
  answer,
  createClock,
  createFakeTimers,
  installFetch,
  json,
  record,
  recordingLogger,
} from './helpers/fakes.js';

const CONFIG = { api_key: API_KEY, station_1: 'Kungälv', poll_interval: 10 };
const DEVICE = 'ext:trafikverket:station:se_sta_vvis1001';

let fake;
afterEach(() => fake?.restore());

/** A storage that records the instant of each write. */
function timedStorage(clock, initial) {
  const inner = memoryStorage(initial);
  const times = [];
  return {
    times,
    load: () => inner.load(),
    save(value) {
      times.push(clock.now());
      inner.save(value);
    },
    get value() {
      return inner.load();
    },
  };
}

/**
 * A fake Trafikverket: `ctx.respond(call)` answers each request; by default a
 * measurement 10 minutes old at the instant of the request.
 */
async function setup({ config = CONFIG, storage, clock = createClock() } = {}) {
  const ctx = { clock };
  ctx.respond = () => json(answer([record({ sampleAt: clock.now() - 10 * 60_000 })]));
  fake = installFetch([
    [/^https:\/\/api\.trafikinfo\.trafikverket\.se\/v2\/data\.json$/, (c) => ctx.respond(c)],
  ]);
  const gladys = createFakeGladys({ selector: 'trafikverket', config });
  const published = [];
  const original = gladys.publishChangedStates.bind(gladys);
  gladys.publishChangedStates = async (states, options) => {
    published.push(states.map((s) => [s.device_feature_external_id, s.state]));
    return original(states, options);
  };
  const timers = createFakeTimers();
  const logger = recordingLogger();
  const app = new TrafikverketApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers,
    storage: storage ?? timedStorage(clock),
  });
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
  await gladys.connect();
  return Object.assign(ctx, { app, gladys, timers, logger, published });
}

const requests = () => fake.calls.length;

/** Advance the clock tick by tick for `ms`, running the periodic checks. */
async function advance(ctx, ms) {
  for (let t = 0; t < ms; t += TICK) {
    ctx.clock.advance(TICK);
    await ctx.timers.runIntervals();
  }
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

test('a station: its device, its values, the status; the key nowhere but the request body', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  const { gladys } = ctx;
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    [DEVICE],
  );
  const device = gladys.fake.discoveredDevices[0];
  assert.equal(device.name, 'Trafikverket Kungälv');
  assert.ok(device.features.every((f) => f.read_only === true));
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
    [
      'air_temperature',
      'road_temperature',
      'dew_point',
      'humidity',
      'wind_speed',
      'wind_gust',
      'wind_direction',
      'precipitation',
      'rain',
      'snow',
      'road_ice',
      'road_ice_depth',
      'road_snow',
      'road_water',
      'road_water_depth',
    ],
  );
  await createAll(gladys);
  assert.equal(gladys.fake.lastState(`${DEVICE}:air_temperature`), 6.4);
  assert.equal(gladys.fake.lastState(`${DEVICE}:road_temperature`), 3.1);
  assert.equal(gladys.fake.lastState(`${DEVICE}:wind_direction`), 225);
  assert.equal(gladys.fake.lastState(`${DEVICE}:precipitation`), 1.2, 'mm per 30 min x 2');
  assert.equal(gladys.fake.lastState(`${DEVICE}:rain`), 1);
  assert.equal(gladys.fake.lastState(`${DEVICE}:road_ice`), 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /1 Trafikverket road weather station\(s\), read every 10 min/,
  );
  // The key travels only in the body of the one request, never in its URL.
  assert.equal(requests(), 1);
  assert.ok(!fake.calls[0].url.includes(API_KEY));
  assert.ok(fake.calls[0].init.body.includes(`authenticationkey="${API_KEY}"`));
  const everything = JSON.stringify([
    ctx.logger.lines,
    gladys.fake.connectionStatuses,
    gladys.fake.discoveredDevices,
    gladys.fake.requests,
    ctx.app.store.storage.value,
  ]);
  assert.ok(!everything.includes(API_KEY));
});

test('the test button never reads closer than the interval to the last read', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  let result;
  for (let i = 0; i < 5; i += 1) {
    ctx.clock.advance(10_000);
    result = await ctx.app.testConnection();
  }
  assert.equal(requests(), 1);
  assert.match(
    result.en,
    /Kungälv \(SE_STA_VVIS1001\): air temperature 6.4 °C, road temperature 3.1 °C/,
  );
  assert.match(result.en, /measured 11 min ago/);
  assert.match(result.en, /next read possible at 12:10 UTC/);
  assert.match(result.fr, /prochaine lecture possible à 12:10 UTC/);
  assert.match(result.fr, /température de l'air 6,4 °C/);
  ctx.clock.advance(10 * 60_000);
  await ctx.app.testConnection();
  assert.equal(requests(), 2, 'once the interval has passed');
});

test('the periodic reads follow the interval; a reconnection, a saved configuration or Discovery never reads sooner', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  await advance(ctx, 9 * 60_000);
  await ctx.app.start(CONFIG);
  await ctx.app.publishDiscovered({ force: true });
  assert.equal(requests(), 1);
  await advance(ctx, 60_000);
  assert.equal(requests(), 2);
  await advance(ctx, 10 * 60_000);
  assert.equal(requests(), 3);
});

test('a restart 30 s after a read: no read, the Discovery list and the status kept', async () => {
  const clock = createClock();
  const storage = timedStorage(clock);
  const first = await setup({ storage, clock });
  await first.app.start(CONFIG);
  first.app.shutdown();
  fake.restore();
  clock.advance(30_000);
  const ctx = await setup({ storage, clock });
  await ctx.app.start(CONFIG);
  assert.equal(requests(), 0, 'no read before the interval');
  assert.deepEqual(
    ctx.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [DEVICE],
  );
  assert.ok(ctx.gladys.fake.discoveredDevices[0].features.length > 10);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /1 Trafikverket road weather station/);
  await advance(ctx, 10 * 60_000);
  assert.equal(requests(), 1);
});

test('the instant of a request is on disk before it leaves; the file is written at most once per minute', async () => {
  const clock = createClock();
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock });
  ctx.respond = () => {
    assert.equal(storage.value.pace.lastAttemptAt, clock.now(), 'written before the request');
    return json(answer([record({ sampleAt: clock.now() - 60_000 })]));
  };
  await ctx.app.start(CONFIG);
  for (let i = 0; i < 6; i += 1) {
    await advance(ctx, 10 * 60_000);
    await ctx.timers.runTimeouts();
  }
  for (let i = 1; i < storage.times.length; i += 1) {
    assert.ok(storage.times[i] - storage.times[i - 1] >= 60_000, `writes ${i - 1} and ${i}`);
  }
  assert.ok(requests() >= 6);
});

test('a refused key: final, persisted, never tried again by itself, not even after a restart', async () => {
  const clock = createClock();
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock });
  ctx.respond = () =>
    json({ RESPONSE: { RESULT: [{ ERROR: { SOURCE: 'Authentication' } }] } }, 401);
  await ctx.app.start(CONFIG);
  assert.equal(requests(), 1);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /refused the API key/);
  assert.equal(storage.value.pace.refused, true);
  assert.match(storage.value.pace.fp, /^[0-9a-f]{32}$/);
  await advance(ctx, 24 * 60 * 60_000);
  assert.equal(requests(), 1, 'never again by itself');
  ctx.app.shutdown();
  fake.restore();
  const again = await setup({ storage, clock });
  again.respond = ctx.respond;
  await again.app.start(CONFIG);
  await advance(again, 60 * 60_000);
  assert.equal(requests(), 0, 'the refusal survives the restart');
  assert.match(again.gladys.fake.connectionStatus.message.en, /refused the API key/);
  // The test button tries once (the interval has passed); still refused.
  await again.app.testConnection();
  assert.equal(requests(), 1);
  await again.app.testConnection();
  assert.equal(requests(), 1, 'not twice within the interval');
  assert.equal(storage.value.pace.refused, true);
  // It succeeds: the refusal is lifted, the periodic reads resume.
  again.respond = () => json(answer([record({ sampleAt: clock.now() - 60_000 })]));
  clock.advance(10 * 60_000);
  await again.app.testConnection();
  assert.equal(storage.value.pace.refused, false);
  assert.equal(storage.value.pace.fp, '');
  await advance(again, 10 * 60_000);
  assert.equal(requests(), 3);
});

test('another key lifts the refusal and is tried a minute after the last request, also after a restart', async () => {
  const clock = createClock();
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock });
  ctx.respond = () => json({}, 401);
  await ctx.app.start(CONFIG);
  ctx.app.shutdown();
  fake.restore();
  clock.advance(5_000);
  const again = await setup({ storage, clock });
  await again.app.start({ ...CONFIG, api_key: OTHER_KEY });
  assert.equal(requests(), 0, 'not within the minute');
  await advance(again, 60_000);
  assert.equal(requests(), 1);
  assert.ok(fake.calls[0].init.body.includes(OTHER_KEY));
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  await advance(again, 5 * 60_000);
  assert.equal(requests(), 1, 'then the interval again');
});

test('a 429 pauses the reads (Retry-After kept), also across a restart; a 5xx doubles', async () => {
  const clock = createClock();
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock });
  ctx.respond = () => json({}, 429, { 'retry-after': '3600' });
  await ctx.app.start(CONFIG);
  assert.equal(storage.value.pace.pausedUntil, NOW + 3_600_000);
  await advance(ctx, 30 * 60_000);
  assert.equal(requests(), 1);
  ctx.app.shutdown();
  fake.restore();
  const again = await setup({ storage, clock });
  again.respond = () => json({}, 503);
  await again.app.start(CONFIG);
  await advance(again, 29 * 60_000);
  assert.equal(requests(), 0, 'the pause survives the restart');
  await advance(again, 60_000 + TICK);
  assert.equal(requests(), 1);
  // Second failure in a row: 10 minutes.
  assert.ok(storage.value.pace.pausedUntil - clock.now() > 9 * 60_000);
  assert.match(again.gladys.fake.connectionStatus.message.en, /service unavailable/);
  // A file claiming a pause of 10 days is capped.
  const capped = timedStorage(clock, {
    pace: { pausedUntil: clock.now() + 10 * 24 * 3_600_000 },
  });
  const app = new TrafikverketApp({ gladys: again.gladys, storage: capped, now: clock.now });
  assert.ok(app.store.get().pausedUntil <= clock.now() + BUSY_MAX);
});

test('a reconnection during a read: no second read, the late answer publishes nothing', async () => {
  const ctx = await setup();
  let release;
  ctx.respond = () =>
    new Promise((resolve) => {
      release = () => resolve(json(answer([record({ sampleAt: NOW - 60_000 })])));
    });
  const running = ctx.app.start(CONFIG);
  await new Promise((resolve) => setImmediate(resolve));
  ctx.app.stop();
  const restarted = ctx.app.start(CONFIG);
  release();
  await running;
  await restarted;
  assert.equal(requests(), 1);
  assert.equal(ctx.published.length, 0);
});

test('an old measurement is never published, nor the same one twice, even after a restart', async () => {
  const clock = createClock();
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock });
  const sampleAt = NOW - 5 * 60_000;
  ctx.respond = () => json(answer([record({ sampleAt })]));
  await ctx.app.start(CONFIG);
  await createAll(ctx.gladys);
  const before = ctx.published.length;
  assert.ok(before >= 1);
  // The station stopped measuring: the same Sample, read again and again.
  await advance(ctx, 30 * 60_000);
  assert.ok(requests() >= 3);
  assert.equal(ctx.published.length, before, 'the same measurement is not published again');
  ctx.app.shutdown();
  fake.restore();
  const again = await setup({ storage, clock });
  again.respond = ctx.respond;
  await advance(again, 10 * 60_000);
  await again.app.start(CONFIG);
  await advance(again, 10 * 60_000);
  assert.ok(requests() >= 1);
  assert.equal(again.published.length, 0, 'not after a restart either');
  // Past the stale limit (1 hour at a 10 min interval): "no recent measurement".
  await advance(again, 60 * 60_000);
  assert.match(again.gladys.fake.connectionStatus.message.en, /Kungälv \(no recent measurement\)/);
  assert.equal(again.gladys.fake.connectionStatus.connected, false);
  const button = await again.app.testConnection();
  assert.match(button.en, /no recent measurement/);
});

test('a measurement older than the limit, dated in the future, or without a readable date: never published', async () => {
  for (const sample of [
    { sampleAt: NOW - 61 * 60_000 },
    { sampleAt: NOW + 30 * 60_000 },
    { sample: 'yesterday' },
  ]) {
    const ctx = await setup();
    ctx.respond = () => json(answer([record(sample)]));
    await ctx.app.start(CONFIG);
    await createAll(ctx.gladys);
    assert.equal(ctx.published.length, 0, JSON.stringify(sample));
    fake.restore();
  }
});

test('the age is measured on the clock of the service (Date header), then on the monotonic clock', async () => {
  const ctx = await setup();
  // The clock of Gladys is 3 hours late; the service says the measurement is 5 min old.
  ctx.clock.jump(-3 * 3_600_000);
  ctx.respond = () =>
    json(answer([record({ sampleAt: NOW - 5 * 60_000 })]), 200, {
      date: new Date(NOW).toUTCString(),
    });
  await ctx.app.start(CONFIG);
  await createAll(ctx.gladys);
  assert.equal(ctx.gladys.fake.lastState(`${DEVICE}:air_temperature`), 6.4);
  // The wall clock jumps by a day: the reading is not aged by it.
  ctx.clock.jump(24 * 3_600_000);
  assert.equal(ctx.app.isFresh(ctx.app.stations.get('se_sta_vvis1001')), true);
  ctx.clock.advance(56 * 60_000);
  assert.equal(ctx.app.isFresh(ctx.app.stations.get('se_sta_vvis1001')), false);
});

test('a new measurement is published; a device created later gets the fresh one only', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  assert.equal(ctx.published.length, 0, 'nothing created yet');
  await createAll(ctx.gladys);
  assert.equal(ctx.published.length, 1);
  ctx.respond = () => json(answer([record({ sampleAt: ctx.clock.now() - 60_000, air: 7 })]));
  await advance(ctx, 10 * 60_000);
  assert.equal(ctx.gladys.fake.lastState(`${DEVICE}:air_temperature`), 7);
  // 2 hours later, the device is deleted and created again: the old values are not sent.
  ctx.respond = () => json(answer([record({ sampleAt: NOW })]));
  await advance(ctx, 2 * 60 * 60_000);
  const count = ctx.published.length;
  await createAll(ctx.gladys);
  assert.equal(ctx.published.length, count);
});

test('a device once created never loses a feature', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  await createAll(ctx.gladys);
  // The station stops sending its wind (sensor out of order) and a restart forgets the fields.
  ctx.app.stations.get('se_sta_vvis1001').fields = new Set(['air_temperature']);
  ctx.respond = () => json(answer([record({ sampleAt: ctx.clock.now() - 60_000, wind: [] })]));
  await advance(ctx, 10 * 60_000);
  await ctx.app.publishDiscovered({ force: true });
  const device = ctx.gladys.fake.discoveredDevices[0];
  assert.ok(device.features.some((f) => f.external_id.endsWith(':wind_speed')));
});

test('entries: by name or id, case aside; not found and ambiguous told by number, never echoed', async () => {
  const ctx = await setup({
    config: {
      api_key: API_KEY,
      station_1: 'kungälv',
      station_2: 'SE_STA_VVIS2002',
      station_3: 'Nowhere-secret-text',
      station_4: 'Bro',
      poll_interval: 10,
    },
  });
  ctx.respond = () =>
    json(
      answer([
        record({ sampleAt: NOW - 60_000 }),
        record({ id: 'SE_STA_VVIS2002', name: 'Ljungskile', sampleAt: NOW - 60_000 }),
        record({ id: 'SE_STA_VVIS3001', name: 'Bro', sampleAt: NOW - 60_000 }),
        record({ id: 'SE_STA_VVIS3002', name: 'Bro', sampleAt: NOW - 60_000 }),
        record({ id: 'SE_STA_VVIS9999', name: 'Other', sampleAt: NOW - 60_000 }),
      ]),
    );
  await ctx.app.start(ctx.gladys.fake.config ?? (await ctx.gladys.getConfig()));
  assert.deepEqual(
    ctx.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [DEVICE, 'ext:trafikverket:station:se_sta_vvis2002'],
  );
  const message = ctx.gladys.fake.connectionStatus.message;
  assert.match(message.en, /Station 3 not found at Trafikverket/);
  assert.match(
    message.en,
    /Station 4 matches several stations \(SE_STA_VVIS3001, SE_STA_VVIS3002\)/,
  );
  assert.match(message.fr, /La station 4 correspond à plusieurs stations/);
  assert.ok(!JSON.stringify(ctx.gladys.fake.connectionStatuses).includes('Nowhere-secret-text'));
  // The query asks each entry by id and by name, escaped.
  const body = fake.calls[0].init.body;
  assert.match(body, /<EQ name="Name" value="kungälv"\/>/);
  assert.match(body, /<EQ name="Id" value="SE_STA_VVIS2002"\/>/);
});

test('the configuration messages; a bad key is refused before any request', async () => {
  const ctx = await setup({ config: {} });
  await ctx.app.start({});
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Enter your API key/);
  await ctx.app.start({ api_key: API_KEY });
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /at least one road weather station/);
  await ctx.app.start({ station_1: 'Kungälv' });
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Saisissez votre clé/);
  const bad = `${API_KEY}"/><QUERY`;
  await ctx.app.start({ api_key: bad, station_1: 'Kungälv' });
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /API key not valid/);
  assert.ok(!JSON.stringify(ctx.gladys.fake.connectionStatuses).includes(bad));
  const button = await ctx.app.testConnection();
  assert.match(button.en, /API key not valid/);
  await ctx.app.start({ api_key: API_KEY, station_1: 'a\nb', station_2: 'X', station_3: 'x' });
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Station 1 ignored: not understood/);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Station 3 ignored: entered twice/);
  assert.equal(requests(), 1, 'only the last configuration was read');
});

test('a network failure or an error of the query: retried at the interval, the key never logged', async () => {
  const ctx = await setup();
  ctx.respond = () => {
    throw new TypeError(`fetch failed ${API_KEY}`);
  };
  await ctx.app.start(CONFIG);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Trafikverket \(no answer\)/);
  ctx.respond = () =>
    json({ RESPONSE: { RESULT: [{ ERROR: { SOURCE: 'Request', MESSAGE: API_KEY } }] } }, 400);
  await advance(ctx, 10 * 60_000);
  assert.equal(requests(), 2);
  ctx.respond = () => json({ RESPONSE: { RESULT: [{ ERROR: { SOURCE: API_KEY } }] } });
  await advance(ctx, 10 * 60_000);
  assert.equal(requests(), 3);
  assert.ok(ctx.logger.lines.length >= 3);
  assert.ok(!ctx.logger.lines.join('\n').includes(API_KEY));
});

test('the states of one read stay far under the 300 per minute of the core', async () => {
  const { FIELDS } = await import('../src/fields.js');
  const { MAX_STATIONS } = await import('../src/constants.js');
  assert.ok(FIELDS.length * MAX_STATIONS <= 100);
});
