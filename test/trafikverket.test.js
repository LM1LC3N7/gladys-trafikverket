// -----------------------------------------------------------------------------
// The client of the open API (query, escaping, answer, errors, bounds), the
// values of a measurement and the instant of a measurement.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY } from '../src/constants.js';
import { at, valuesOf } from '../src/fields.js';
import { retryAfterMs } from '../src/http.js';
import { parseSample } from '../src/time.js';
import { ApiError, buildQuery, readStations, xmlEscape } from '../src/trafikverket.js';
import { API_KEY, NOW, answer, installFetch, json, record } from './helpers/fakes.js';

let fake;
afterEach(() => fake?.restore());

const URL_PATTERN = /^https:\/\/api\.trafikinfo\.trafikverket\.se\/v2\/data\.json$/;

async function rejects(promise, kind) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ApiError, String(err));
    assert.equal(err.kind, kind);
    return true;
  });
}

test('the query: POST, XML, the key escaped in LOGIN, each entry by id and by name', async () => {
  fake = installFetch([[URL_PATTERN, () => json(answer([record()]))]]);
  await readStations(API_KEY, ['Kungälv', 'A&B "<x>" \'y\'']);
  const [{ init }] = fake.calls;
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.match(init.headers['Content-Type'], /^text\/xml/);
  assert.match(init.headers['User-Agent'], /^gladys-trafikverket/);
  const body = init.body;
  assert.match(body, /^<REQUEST><LOGIN authenticationkey="0123456789abcdef0123456789abcdef"\/>/);
  assert.match(body, /<QUERY objecttype="WeatherMeasurepoint" schemaversion="2\.1" limit="50">/);
  assert.match(body, /<EQ name="Deleted" value="false"\/>/);
  assert.match(body, /<EQ name="Name" value="Kungälv"\/>/);
  assert.match(
    body,
    /<EQ name="Name" value="A&amp;B &quot;&lt;x&gt;&quot; &apos;y&apos;"\/>/,
    'every entity escaped',
  );
  assert.match(body, /<INCLUDE>Observation\.Surface\.Ice<\/INCLUDE>/);
  // Only the weather stations: never trains, ferries or cameras.
  assert.doesNotMatch(body, /Train|Ferry|Camera/);
});

test('XML escaping: no way out of an attribute', () => {
  assert.equal(xmlEscape(`a"/><QUERY x='1'>&`), 'a&quot;/&gt;&lt;QUERY x=&apos;1&apos;&gt;&amp;');
  const xml = buildQuery('k"/><X', ['"/><LOGIN authenticationkey="evil']);
  assert.equal(xml.match(/<LOGIN /g).length, 1);
  assert.equal(xml.match(/"/g).length % 2, 0);
});

test('the answer: stations with their values and the instant of their measurement', async () => {
  fake = installFetch([
    [
      URL_PATTERN,
      () =>
        json(
          answer([
            record({ sampleAt: NOW - 600_000 }),
            record(),
            { Id: 'bad id!', Name: 'X' },
            'not an object',
            record({ id: 'SE_STA_VVIS2', name: 'Bro\u0007\u009b', sample: 'never' }),
          ]),
          200,
          { date: new Date(NOW).toUTCString() },
        ),
    ],
  ]);
  const { date, stations } = await readStations(API_KEY, ['Kungälv']);
  assert.equal(date, NOW);
  assert.deepEqual(
    stations.map((s) => [s.key, s.name, s.sampleAt]),
    [
      ['se_sta_vvis1001', 'Kungälv', NOW - 600_000],
      ['se_sta_vvis2', 'Bro', null],
    ],
    'deduplicated, invalid ids dropped, control characters removed',
  );
  assert.deepEqual(stations[0].values, {
    air_temperature: 6.4,
    road_temperature: 3.1,
    dew_point: 4.4,
    humidity: 87.5,
    wind_speed: 4.2,
    wind_gust: 9.8,
    wind_direction: 225,
    precipitation: 1.2,
    rain: 1,
    snow: 0,
    road_ice: 0,
    road_ice_depth: 0,
    road_snow: 0,
    road_water: 1,
    road_water_depth: 0.2,
  });
});

test('statuses and errors: refused, limited, busy, failed, invalid', async () => {
  const cases = [
    [() => json({}, 401), 'refused'],
    [() => json({}, 403), 'refused'],
    [() => json({}, 429, { 'retry-after': '120' }), 'limited'],
    [() => json({}, 502), 'busy'],
    [() => json({ RESPONSE: { RESULT: [{ ERROR: { SOURCE: 'Request' } }] } }, 400), 'failed'],
    [() => json({ RESPONSE: { RESULT: [{ ERROR: { SOURCE: 'Request' } }] } }), 'failed'],
    [() => new Response('<html>', { status: 200 }), 'invalid'],
    [() => json({ RESPONSE: {} }), 'invalid'],
    [() => json({ RESPONSE: { RESULT: [{ WeatherMeasurepoint: {} }] } }), 'invalid'],
    [() => new Response(null, { status: 302, headers: { location: 'https://x' } }), 'failed'],
    [
      () => {
        throw new TypeError('fetch failed');
      },
      'failed',
    ],
  ];
  for (const [respond, kind] of cases) {
    fake = installFetch([[URL_PATTERN, respond]]);
    await rejects(readStations(API_KEY, ['x']), kind);
    fake.restore();
  }
  fake = installFetch([[URL_PATTERN, () => json({}, 429, { 'retry-after': '120' })]]);
  await assert.rejects(readStations(API_KEY, ['x']), (err) => err.retryAfterMs === 120_000);
  // An empty list is an answer (no station of that name).
  fake.restore();
  fake = installFetch([[URL_PATTERN, () => json({ RESPONSE: { RESULT: [{}] } })]]);
  assert.deepEqual((await readStations(API_KEY, ['x'])).stations, []);
});

test('the error messages carry neither the key nor the answer', async () => {
  fake = installFetch([
    [URL_PATTERN, () => json({ RESPONSE: { RESULT: [{ ERROR: { MESSAGE: API_KEY } }] } }, 400)],
  ]);
  await assert.rejects(readStations(API_KEY, ['x']), (err) => !err.message.includes(API_KEY));
});

test('an answer too large is refused, read in chunks without holding more than the limit', async () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let sent = 0;
  fake = installFetch([
    [
      URL_PATTERN,
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              sent += chunk.byteLength;
              controller.enqueue(chunk);
              if (sent > 10 * MAX_BODY) {
                controller.close();
              }
            },
          }),
        ),
    ],
  ]);
  await rejects(readStations(API_KEY, ['x']), 'failed');
  assert.ok(sent <= MAX_BODY + 3 * chunk.byteLength, `${sent} bytes read`);
});

test('values: own properties only, bounds, strict numbers, the first wind of a list', () => {
  const polluted = JSON.parse(
    '{"__proto__": {"Air": {"Temperature": {"Value": 99}}}, "Surface": {"Temperature": {"Value": ""}}}',
  );
  assert.deepEqual(valuesOf(polluted), {});
  assert.equal({}.Air, undefined, 'no prototype pollution');
  assert.deepEqual(
    valuesOf({
      Air: { Temperature: { Value: '-12.5' }, RelativeHumidity: { Value: 140 } },
      Surface: { Temperature: { Value: 'NaN' }, Ice: 'true', Water: 'yes' },
      Wind: [{ Speed: {} }, { Speed: { Value: 3 }, Direction: { Value: 400 } }],
    }),
    { air_temperature: -12.5, road_ice: 1 },
    'a value out of its bounds or unreadable is dropped, never clamped',
  );
  assert.equal(at({ a: [null, { b: 1 }] }, 'a.b'), 1);
  assert.equal(at({ a: { b: 1 } }, 'a.toString'), undefined);
  assert.deepEqual(valuesOf(null), {});
});

test('the instant of a measurement: offsets, Stockholm time without offset, nonsense refused', () => {
  assert.equal(parseSample('2026-10-24T13:30:00.000+02:00'), Date.UTC(2026, 9, 24, 11, 30));
  assert.equal(parseSample('2026-10-24T11:30:00Z'), Date.UTC(2026, 9, 24, 11, 30));
  // Without offset: Stockholm, summer (+2) and winter (+1).
  assert.equal(parseSample('2026-07-01T12:00:00'), Date.UTC(2026, 6, 1, 10, 0));
  assert.equal(parseSample('2026-01-10T08:00:00'), Date.UTC(2026, 0, 10, 7, 0));
  // Around the changes of time.
  assert.equal(parseSample('2026-03-29T01:30:00'), Date.UTC(2026, 2, 29, 0, 30));
  assert.equal(parseSample('2026-03-29T03:30:00'), Date.UTC(2026, 2, 29, 1, 30));
  assert.equal(parseSample('2026-10-25T01:30:00'), Date.UTC(2026, 9, 24, 23, 30));
  assert.equal(parseSample('2026-10-25T03:30:00'), Date.UTC(2026, 9, 25, 2, 30));
  for (const bad of [
    '',
    'yesterday',
    '2026-02-31T10:00:00Z',
    '2026-10-24T24:00:00Z',
    '2026-10-24T10:00:00+25:00',
    '2026-10-24 10:00:00',
    null,
    1761300000,
  ]) {
    assert.equal(parseSample(bad), null, String(bad));
  }
});

test('Retry-After: seconds or a date, nothing else', () => {
  assert.equal(retryAfterMs('30'), 30_000);
  assert.equal(retryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW), 90_000);
  assert.equal(retryAfterMs(''), undefined);
  assert.equal(retryAfterMs('soon'), undefined);
  assert.equal(retryAfterMs(undefined), undefined);
});
