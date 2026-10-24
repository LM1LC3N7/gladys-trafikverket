// -----------------------------------------------------------------------------
// The one call this integration makes, read only:
//
//   POST https://api.trafikinfo.trafikverket.se/v2/data.json
//   <REQUEST><LOGIN authenticationkey="..."/><QUERY objecttype="WeatherMeasurepoint" ...>
//
// The query of the open API of Trafikverket (as pytrafikverket builds it):
// the key in the LOGIN element, the stations asked by id or by name. Every
// text that enters the XML (the key, a station name) is escaped, and a
// control character is refused before (config.js). The answer is JSON,
// bounded (http.js) and read without following anything it says.
//
// Only `WeatherMeasurepoint` is asked: trains, ferries and cameras of
// Trafikverket are out of this integration.
// -----------------------------------------------------------------------------

import { API_URL, MAX_RECORDS, OBJECT_TYPE, SCHEMA_VERSION } from './constants.js';
import { valuesOf } from './fields.js';
import { NetworkError, postXml } from './http.js';
import { parseSample } from './time.js';

/**
 * kind: refused (401/403: the key), limited (429), busy (5xx), invalid (not
 * an answer of the API), failed (network, another status, an error of the
 * query).
 */
export class ApiError extends Error {
  constructor(kind, detail = '', { retryAfterMs, status } = {}) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'ApiError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

/** XML escaping of an attribute value or a text (all five entities). */
export const xmlEscape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** The paths asked (INCLUDE): only what is read, so the answer stays small. */
export const INCLUDES = [
  'Id',
  'Name',
  'Observation.Sample',
  'Observation.Air.Temperature.Value',
  'Observation.Air.RelativeHumidity.Value',
  'Observation.Air.Dewpoint.Value',
  'Observation.Air.VisibleDistance.Value',
  'Observation.Wind.Direction.Value',
  'Observation.Wind.Speed.Value',
  'Observation.Aggregated30minutes.Wind.SpeedMax.Value',
  'Observation.Aggregated30minutes.Precipitation.TotalWaterEquivalent.Value',
  'Observation.Aggregated30minutes.Precipitation.Rain',
  'Observation.Aggregated30minutes.Precipitation.Snow',
  'Observation.Surface.Temperature.Value',
  'Observation.Surface.Ice',
  'Observation.Surface.IceDepth.Value',
  'Observation.Surface.Snow',
  'Observation.Surface.SnowDepth.Solid.Value',
  'Observation.Surface.Water',
  'Observation.Surface.WaterDepth.Value',
];

/**
 * The XML query: the stations not deleted whose id or name is one of
 * `queries`. Each query gives two EQ filters (id, name), in an OR.
 */
export function buildQuery(apiKey, queries) {
  const filters = queries
    .flatMap((q) => [
      `<EQ name="Id" value="${xmlEscape(q)}"/>`,
      `<EQ name="Name" value="${xmlEscape(q)}"/>`,
    ])
    .join('');
  const includes = INCLUDES.map((path) => `<INCLUDE>${path}</INCLUDE>`).join('');
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlEscape(apiKey)}"/>` +
    `<QUERY objecttype="${OBJECT_TYPE}" schemaversion="${SCHEMA_VERSION}" limit="${MAX_RECORDS}">` +
    `<FILTER><AND><EQ name="Deleted" value="false"/><OR>${filters}</OR></AND></FILTER>` +
    includes +
    '</QUERY>' +
    '</REQUEST>'
  );
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Printable text of the answer, bounded (never a control character). */
export const cleanText = (value, max) =>
  typeof value === 'string'
    ? [...value]
        .filter((c) => {
          const code = c.charCodeAt(0);
          return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
        })
        .join('')
        .trim()
        .slice(0, max)
    : '';

/** A station id of the API ("SE_STA_VVIS..."), or null. */
export const stationIdOf = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null;

/** The key of a station: its id in lower case (part of the external id, forever). */
export const stationKeyOf = (id) => id.toLowerCase();

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('invalid', 'not JSON');
  }
}

/** The ERROR of the answer: its SOURCE only (the MESSAGE may quote the query). */
const errorOf = (body) => {
  const result = body?.RESPONSE?.RESULT;
  const first = Array.isArray(result) ? result[0] : undefined;
  if (!isObject(first) || !Object.hasOwn(first, 'ERROR')) {
    return null;
  }
  return cleanText(first.ERROR?.SOURCE, 40) || 'error';
};

/**
 * Read the stations of `queries` (names or ids). Resolves
 * `{ date, stations }`: `date` is the clock of the service (the `Date`
 * header, or null), `stations` [{ id, key, name, sample, sampleAt, values }]
 * with `sample` the raw `Observation.Sample` and `sampleAt` its instant (ms,
 * or null when unreadable).
 */
export async function readStations(apiKey, queries) {
  let response;
  try {
    response = await postXml(API_URL, buildQuery(apiKey, queries));
  } catch (err) {
    throw new ApiError('failed', err instanceof NetworkError ? err.message : 'network failed');
  }
  const { status, retryAfterMs } = response;
  if (status === 429) {
    throw new ApiError('limited', 'HTTP 429', { retryAfterMs, status });
  }
  if (status >= 500) {
    throw new ApiError('busy', `HTTP ${status}`, { retryAfterMs, status });
  }
  if (status === 401 || status === 403) {
    throw new ApiError('refused', `HTTP ${status}`, { status });
  }
  if (status < 200 || status > 299) {
    let source = '';
    try {
      source = errorOf(JSON.parse(response.text)) ?? '';
    } catch {
      // Not JSON: the status says enough.
    }
    throw new ApiError('failed', `HTTP ${status}${source ? ` (${source})` : ''}`, { status });
  }
  const body = parseJson(response.text);
  const source = errorOf(body);
  if (source) {
    throw new ApiError('failed', `query error (${source})`, { status });
  }
  const result = body?.RESPONSE?.RESULT;
  if (!Array.isArray(result) || !isObject(result[0])) {
    throw new ApiError('invalid', 'no RESULT');
  }
  const records = Object.hasOwn(result[0], OBJECT_TYPE) ? result[0][OBJECT_TYPE] : [];
  if (!Array.isArray(records)) {
    throw new ApiError('invalid', `no ${OBJECT_TYPE} list`);
  }
  const stations = [];
  const seen = new Set();
  for (const record of records.slice(0, MAX_RECORDS)) {
    if (!isObject(record)) {
      continue;
    }
    const id = stationIdOf(record.Id);
    if (id === null || seen.has(stationKeyOf(id))) {
      continue;
    }
    seen.add(stationKeyOf(id));
    const observation = isObject(record.Observation) ? record.Observation : {};
    const sample = typeof observation.Sample === 'string' ? observation.Sample.slice(0, 40) : '';
    stations.push({
      id,
      key: stationKeyOf(id),
      name: cleanText(record.Name, 60) || id,
      sample,
      sampleAt: parseSample(sample),
      values: valuesOf(observation),
    });
  }
  return { date: response.date, stations };
}
