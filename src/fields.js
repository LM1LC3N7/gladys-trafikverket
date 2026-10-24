// -----------------------------------------------------------------------------
// What a road weather station of Trafikverket measures, and how it lands in
// Gladys. Pure: no clock, no network.
//
// The paths are those of the `WeatherMeasurepoint` object, schema 2.1, as
// pytrafikverket (MIT) reads them (`WEATHER_REQUIRED_FIELDS` and
// `weather_from_xml_node`), in the JSON form of the answer. The API sends
// SI values (°C, %, m/s, degrees, mm, metres): only the precipitation is
// converted, from mm per 30 minutes to mm/h, as pytrafikverket does. Every
// unit is one the Gladys core lists for the category
// (DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js).
//
// The feature key is a name of this integration (`road_temperature`...),
// never an API path: it is part of the external id, so it never changes.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE } from './constants.js';

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

// --- Kinds: Gladys category, type, unit, bounds, rounding -------------------------
// The core lists no unit for `angle-sensor`: the wind direction keeps its
// own `degree` unit (as the approved WeatherLink and Ambient Weather
// modules). Ice, snow and water on the road have no category of their own:
// read-only binary sensors of the `unknown` category (never a switch).

const KINDS = {
  temperature: {
    category: CAT.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.CELSIUS,
    min: -60,
    max: 60,
    convert: (v) => round(v, 1),
  },
  // The road surface and the dew point: kept out of the room temperature
  // average of Gladys.
  probe: {
    category: CAT.TEMPERATURE_SENSOR,
    type: TYPES.TEMPERATURE_SENSOR.PROBE,
    unit: UNITS.CELSIUS,
    min: -70,
    max: 80,
    convert: (v) => round(v, 1),
  },
  humidity: {
    category: CAT.HUMIDITY_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    convert: (v) => round(v, 1),
  },
  visibility: {
    category: CAT.DISTANCE_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    unit: UNITS.M,
    min: 0,
    max: 100_000,
    convert: (v) => Math.round(v),
  },
  wind: {
    category: CAT.SPEED_SENSOR,
    type: TYPES.SPEED_SENSOR.DECIMAL,
    unit: UNITS.METER_PER_SECOND,
    min: 0,
    max: 100,
    convert: (v) => round(v, 1),
  },
  direction: {
    category: CAT.ANGLE_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    unit: UNITS.DEGREE,
    min: 0,
    max: 360,
    convert: (v) => Math.round(v),
  },
  rainRate: {
    category: CAT.PRECIPITATION_SENSOR,
    type: TYPES.PRECIPITATION_SENSOR.DECIMAL,
    unit: UNITS.MILLIMETER_PER_HOUR,
    min: 0,
    max: 500,
    convert: (v) => round(v, 1),
  },
  depth: {
    category: CAT.DISTANCE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.MM,
    min: 0,
    max: 5000,
    convert: (v) => round(v, 1),
  },
  rain: {
    category: CAT.RAIN_SENSOR,
    type: TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
    convert: (v) => v,
  },
  flag: {
    category: CAT.UNKNOWN,
    type: TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
    convert: (v) => v,
  },
};

/**
 * [feature key, kind, path in `Observation`, factor, English name, French name].
 * The order is the order of the features in Gladys.
 */
export const FIELDS = [
  [
    'air_temperature',
    'temperature',
    'Air.Temperature.Value',
    1,
    'Air temperature',
    "Température de l'air",
  ],
  [
    'road_temperature',
    'probe',
    'Surface.Temperature.Value',
    1,
    'Road temperature',
    'Température de la route',
  ],
  ['dew_point', 'probe', 'Air.Dewpoint.Value', 1, 'Dew point', 'Point de rosée'],
  ['humidity', 'humidity', 'Air.RelativeHumidity.Value', 1, 'Humidity', 'Humidité'],
  ['visibility', 'visibility', 'Air.VisibleDistance.Value', 1, 'Visibility', 'Visibilité'],
  ['wind_speed', 'wind', 'Wind.Speed.Value', 1, 'Wind speed', 'Vitesse du vent'],
  [
    'wind_gust',
    'wind',
    'Aggregated30minutes.Wind.SpeedMax.Value',
    1,
    'Wind gust (30 min)',
    'Rafale (30 min)',
  ],
  ['wind_direction', 'direction', 'Wind.Direction.Value', 1, 'Wind direction', 'Direction du vent'],
  // mm per 30 minutes -> mm/h (pytrafikverket).
  [
    'precipitation',
    'rainRate',
    'Aggregated30minutes.Precipitation.TotalWaterEquivalent.Value',
    2,
    'Precipitation',
    'Précipitations',
  ],
  ['rain', 'rain', 'Aggregated30minutes.Precipitation.Rain', 1, 'Rain (30 min)', 'Pluie (30 min)'],
  [
    'snow',
    'flag',
    'Aggregated30minutes.Precipitation.Snow',
    1,
    'Snowfall (30 min)',
    'Chute de neige (30 min)',
  ],
  ['road_ice', 'flag', 'Surface.Ice', 1, 'Ice on the road', 'Glace sur la route'],
  [
    'road_ice_depth',
    'depth',
    'Surface.IceDepth.Value',
    1,
    'Ice depth on the road',
    'Épaisseur de glace',
  ],
  ['road_snow', 'flag', 'Surface.Snow', 1, 'Snow on the road', 'Neige sur la route'],
  [
    'road_snow_depth',
    'depth',
    'Surface.SnowDepth.Solid.Value',
    1,
    'Snow depth on the road',
    'Hauteur de neige',
  ],
  ['road_water', 'flag', 'Surface.Water', 1, 'Water on the road', 'Eau sur la route'],
  [
    'road_water_depth',
    'depth',
    'Surface.WaterDepth.Value',
    1,
    'Water depth on the road',
    "Hauteur d'eau",
  ],
];

/** Feature key -> its line of FIELDS. */
const BY_KEY = new Map(FIELDS.map((line) => [line[0], line]));

/** The feature keys this integration knows. */
export const FIELD_KEYS = new Set(BY_KEY.keys());

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The value at a dotted path, own properties only (never one of a
 * prototype). An array met on the way (the wind may come per height) gives
 * its first object.
 */
export function at(root, path) {
  let node = root;
  for (const part of path.split('.')) {
    if (Array.isArray(node)) {
      node = node.slice(0, 8).find(isObject);
    }
    if (!isObject(node) || !Object.hasOwn(node, part)) {
      return undefined;
    }
    node = node[part];
  }
  return node;
}

/** A number of the answer: a finite number, or a strict decimal string; else null. */
export const num = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && /^-?\d{1,7}(\.\d{1,6})?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
};

/** A boolean of the answer -> 1 / 0, else null. */
const flag = (value) => {
  if (value === true || value === 'true') {
    return 1;
  }
  if (value === false || value === 'false') {
    return 0;
  }
  return null;
};

/**
 * The values of one `Observation`: { key: number } for every field the
 * station gave, converted and within the bounds of its kind (a value out of
 * them is dropped, never clamped).
 */
export function valuesOf(observation) {
  const values = {};
  if (!isObject(observation)) {
    return values;
  }
  for (const [key, kindName, path, factor] of FIELDS) {
    const kind = KINDS[kindName];
    const raw = at(observation, path);
    const binary = kind.type === TYPES.SENSOR.BINARY;
    const read = binary ? flag(raw) : num(raw);
    if (read === null) {
      continue;
    }
    const value = kind.convert(read * factor);
    if (Number.isFinite(value) && value >= kind.min && value <= kind.max) {
      values[key] = value;
    }
  }
  return values;
}

/** The features of the device the user created for this station (`gladys.devices`). */
export function createdFeatures(gladys, stationKey) {
  const { device: id } = gladys.externalIds(DEVICE_TYPE, stationKey);
  const device = (gladys.devices ?? []).find((d) => d.external_id === id);
  return Array.isArray(device?.features) ? device.features : [];
}

const featureOf = (ids, key, kindName, name) => {
  const kind = KINDS[kindName];
  return {
    name,
    external_id: ids.feature(key),
    category: kind.category,
    type: kind.type,
    ...(kind.unit ? { unit: kind.unit } : {}),
    min: kind.min,
    max: kind.max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
};

/**
 * The Gladys device of a station: the features of every field the station
 * ever gave (`fields`), in the order of FIELDS, plus every feature of the
 * device already created (a republished device never loses a feature: the
 * core would mark it changed and "Update" would drop its history). The
 * external id is built from the station id of Trafikverket in lower case
 * (`ext:<selector>:station:se_sta_vvis...`), never from its name.
 */
export function deviceOf(gladys, { stationKey, name, fields }) {
  const ids = gladys.externalIds(DEVICE_TYPE, stationKey);
  const created = createdFeatures(gladys, stationKey);
  const createdIds = new Set(created.map((f) => f.external_id));
  const features = FIELDS.filter(
    ([key]) => fields.has(key) || createdIds.has(ids.feature(key)),
  ).map(([key, kindName, , , en]) => featureOf(ids, key, kindName, en));
  const prefix = `${ids.device}:`;
  for (const feature of created) {
    const id = String(feature?.external_id ?? '');
    const key = id.startsWith(prefix) ? id.slice(prefix.length) : '';
    if (key && !BY_KEY.has(key)) {
      features.push({
        name: feature.name,
        external_id: id,
        category: feature.category,
        type: feature.type,
        ...(feature.unit ? { unit: feature.unit } : {}),
        min: feature.min,
        max: feature.max,
        read_only: true,
        has_feedback: false,
        keep_history: feature.keep_history !== false,
      });
    }
  }
  return {
    name,
    external_id: ids.device,
    // The integration reads Trafikverket at its own pace: Gladys has nothing to poll.
    should_poll: false,
    features,
  };
}

/** The states of a station: [{ device_feature_external_id, state }]. */
export function statesOf(gladys, { stationKey, values }) {
  const ids = gladys.externalIds(DEVICE_TYPE, stationKey);
  const states = [];
  for (const [key, value] of Object.entries(values)) {
    if (BY_KEY.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      states.push({ device_feature_external_id: ids.feature(key), state: value });
    }
  }
  return states;
}
