// -----------------------------------------------------------------------------
// The integration itself: when the stations are due, the pause and the
// refusal, which station answers which configured entry, the freshness of
// each measurement, the Gladys devices and states, the connection status and
// the test button. index.js only wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { isReady, normalizeConfig } from './config.js';
import {
  BUSY_BASE,
  BUSY_MAX,
  BUSY_MIN,
  DEVICE_TYPE,
  FUTURE_SLACK,
  NEW_KEY_GAP,
  STALE,
  STALE_MAX,
  TEST_DEADLINE,
  TICK,
} from './constants.js';
import { FIELDS, deviceOf, statesOf } from './fields.js';
import { T, reason } from './i18n.js';
import { StateStore, memoryStorage } from './store.js';
import { ApiError, readStations } from './trafikverket.js';

const defaultTimers = { setInterval, clearInterval, setTimeout, clearTimeout };
const defaultClient = { readStations };
const defaultMonotonic = () => performance.now();

/** An unchanged value backed by a new measurement is sent again this often. */
const HEARTBEAT = 30 * 60_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 12.54 -> "12.5", "12,5" in French. */
const numberText = (value, lang) => {
  const text = String(Math.round(value * 10) / 10);
  return lang === 'fr' ? text.replace('.', ',') : text;
};

const asApiError = (err) => (err instanceof ApiError ? err : new ApiError('failed'));

/** A configured entry names this station: its id or its name, case aside. */
const names = (station, query) => {
  const q = query.toLowerCase();
  return station.id.toLowerCase() === q || station.name.toLowerCase() === q;
};

/** A station in memory, from the file or from a first answer. */
const newStation = (saved) => ({
  key: saved.key,
  id: saved.id,
  name: saved.name,
  fields: new Set(saved.fields ?? []),
  /** The last measurement published: raw Sample, its instant, when it changed. */
  sample: saved.sample ?? '',
  sampleAt: saved.sampleAt ?? null,
  changedAt: saved.changedAt ?? 0,
  seenAt: saved.seenAt ?? 0,
  /** The last fresh reading: { values, sampleAt, age, readAt (monotonic) }. */
  reading: undefined,
  error: undefined,
});

export class TrafikverketApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'trafikverket' }),
    now = Date.now,
    monotonic = defaultMonotonic,
    timers = defaultTimers,
    storage = memoryStorage(),
    client = defaultClient,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.client = client;
    this.config = normalizeConfig();
    // The pace, the pause and the refusal live as long as the process,
    // across restarts of the app and reconnections to Gladys, and in /data
    // across restarts of the container.
    this.store = new StateStore({ storage, now, timers, maxPause: BUSY_MAX });
    /** station key -> station (every station met, configured or not). */
    this.stations = new Map();
    for (const saved of this.store.stations.values()) {
      this.stations.set(saved.key, newStation(saved));
    }
    /** slot -> { keys: [station keys], ambiguous: [ids] } from the last answer. */
    this.resolved = new Map();
    /** The account: undefined, or the kind of the last failure. */
    this.error = undefined;
    /** A new key: tried NEW_KEY_GAP after the last request (once). */
    this.freshKey = false;
    this.interval = undefined;
    this.ticking = undefined;
    this.chain = Promise.resolve();
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    const previous = this.config;
    this.config = normalizeConfig(raw);
    if (JSON.stringify(previous.stations) !== JSON.stringify(this.config.stations)) {
      this.resolved = new Map();
    }
    if (isReady(this.config)) {
      // The store lifts the refusal of another key (seen in memory while the
      // process runs, or after a restart against the fingerprint of a key
      // still refused). Anything else (a reconnection to Gladys, a restart
      // of the container, a saved configuration) keeps the pace: the next
      // read is never before the last request + the interval.
      const { pace, changed } = this.store.restore(this.config.apiKey);
      if (changed) {
        this.error = undefined;
        this.freshKey = true;
      }
      if (pace.refused) {
        this.error = 'refused';
      } else if (!this.error && pace.pausedUntil > this.now()) {
        this.error = 'busy';
      }
    }
    // Gladys keeps the status and the Discovery list in memory only: a
    // (re)connection may follow a restart of the core, so both are published
    // again even when nothing changed.
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    await this.tick();
    if (generation !== this.generation) {
      return;
    }
    this.interval = this.timers.setInterval(
      () => this.tick().catch((err) => this.logger.warn(`Refresh failed: ${this.scrub(err)}`)),
      TICK,
    );
    await this.publishDiscovered();
    await this.refreshStatus();
  }

  stop() {
    this.generation += 1;
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /** The container stops: the state file is written, the timers dropped. */
  shutdown() {
    this.stop();
    this.store.flushNow();
    this.store.close();
  }

  /** An error message without the API key. */
  scrub(err) {
    let message = String(err?.message ?? err);
    const key = this.config.apiKey;
    if (key && key.length >= 4) {
      message = message.split(key).join('***');
    }
    return message;
  }

  /** Run `fn` after every read already queued: never two reads at once. */
  exclusive(fn) {
    const run = this.chain.catch(() => {}).then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // --- Pace ---------------------------------------------------------------------------

  intervalMs() {
    return this.config.pollMinutes * 60_000;
  }

  /** A measurement older than this is never published (1 to 2 hours). */
  staleMs() {
    return clamp(2 * this.intervalMs(), STALE, STALE_MAX);
  }

  /**
   * The earliest read: the interval (NEW_KEY_GAP for a new key) after the
   * last request, and the end of a pause. A refused key is never read
   * again by itself (`manual`: the test button may try it once the interval
   * has passed).
   */
  earliest({ manual = false } = {}) {
    const pace = this.store.get();
    const gap = this.freshKey ? NEW_KEY_GAP : this.intervalMs();
    const at = Math.max(pace.lastAttemptAt + gap, pace.pausedUntil);
    if (pace.refused && !manual) {
      return Infinity;
    }
    return at;
  }

  /** When the next read can happen (shown by the test button). */
  nextRead() {
    return Math.max(this.earliest({ manual: true }), this.store.writableAt(), this.now());
  }

  // --- Reading -----------------------------------------------------------------------

  /** Read if due (a tick never overlaps another). */
  tick({ manual = false } = {}) {
    if (!manual && this.ticking && this.tickGeneration === this.generation) {
      return this.ticking;
    }
    const generation = this.generation;
    const run = this.exclusive(() => this.readDue({ manual })).finally(() => {
      if (this.ticking === run) {
        this.ticking = undefined;
      }
    });
    if (!manual) {
      this.ticking = run;
      this.tickGeneration = generation;
    }
    return run;
  }

  /**
   * Read the configured stations once the interval has passed. Nothing, not
   * even the test button (`manual`), reads before the last request + the
   * interval, nor during a pause; `manual` may try a refused key again once
   * the interval has passed. The instant of the request is written to /data
   * before it leaves (a read waits until a write is allowed).
   */
  async readDue({ manual = false } = {}) {
    if (!isReady(this.config)) {
      return;
    }
    const generation = this.generation;
    const now = this.now();
    if (now < this.earliest({ manual }) || !this.store.canWrite()) {
      return;
    }
    this.store.update({ lastAttemptAt: now }, undefined, { defer: true });
    this.store.flush();
    this.freshKey = false;
    const key = this.config.apiKey;
    const queries = this.config.stations.map((s) => s.query);
    try {
      const answer = await this.client.readStations(key, queries);
      if (generation !== this.generation) {
        return;
      }
      this.error = undefined;
      this.store.update({ pausedUntil: 0, streak: 0, refused: false });
      await this.apply(answer, generation);
    } catch (err) {
      this.failed(asApiError(err), key, generation === this.generation);
      return;
    }
    if (generation === this.generation) {
      await this.publishDiscovered();
      await this.refreshStatus();
    }
  }

  /** A failed read: refusal (final), pause, or a passing failure (retried at the interval). */
  failed(error, key, current) {
    const sameKey = key === this.config.apiKey;
    if (error.kind === 'refused' && sameKey) {
      // Final: persisted, never tried again by itself (lifted by another key,
      // or by the test button once it succeeds).
      this.store.update({ refused: true }, key);
    } else if ((error.kind === 'limited' || error.kind === 'busy') && sameKey) {
      this.recordBusy(error);
    }
    if (!current) {
      // Disconnected (or reconfigured) meanwhile: no status is set.
      return;
    }
    this.error = error.kind;
    this.logger.warn(`Trafikverket: ${this.scrub(error)}`);
    this.refreshStatus().catch(() => {});
  }

  /** A 429 / 5xx: Retry-After, else 5 minutes doubling; 1 minute to 6 hours. */
  recordBusy(error) {
    const streak = this.store.get().streak + 1;
    const pause = clamp(
      error.retryAfterMs ?? BUSY_BASE * 2 ** Math.min(streak - 1, 10),
      BUSY_MIN,
      BUSY_MAX,
    );
    this.store.update({ streak, pausedUntil: this.now() + pause });
  }

  /** The keys of the stations configured now (from the last answer, else from the file). */
  configuredKeys() {
    const keys = [];
    for (const { slot, query } of this.config.stations) {
      const resolved = this.resolved.get(slot);
      const found = resolved
        ? resolved.keys
        : [...this.stations.values()].filter((s) => names(s, query)).map((s) => s.key);
      for (const key of found.length === 1 ? found : []) {
        if (!keys.includes(key)) {
          keys.push(key);
        }
      }
    }
    return keys;
  }

  /**
   * An answer: which station answers which entry, and the measurements.
   * A measurement is published only when it is fresh (its age, on the
   * clock of the service, within the stale limit) and newer than the last
   * one published for the station (kept under /data): an old measurement is
   * never published again as a new one, even after a restart.
   */
  async apply({ date, stations: records }, generation = this.generation) {
    const now = this.now();
    const reference = Number.isFinite(date) ? date : now;
    const mono = this.monotonic();
    this.resolved = new Map();
    for (const { slot, query } of this.config.stations) {
      const found = records.filter((r) => names(r, query));
      this.resolved.set(slot, {
        keys: found.length === 1 ? [found[0].key] : [],
        ambiguous: found.length > 1 ? found.map((r) => r.id).slice(0, 5) : [],
      });
    }
    const configured = this.configuredKeys();
    const fresh = [];
    for (const record of records) {
      if (!configured.includes(record.key)) {
        continue;
      }
      let station = this.stations.get(record.key);
      if (!station) {
        station = newStation({ key: record.key, id: record.id, name: record.name });
        this.stations.set(record.key, station);
      }
      station.name = record.name;
      station.seenAt = now;
      for (const field of Object.keys(record.values)) {
        station.fields.add(field);
      }
      const age = record.sampleAt === null ? null : reference - record.sampleAt;
      const usable = age !== null && age >= -FUTURE_SLACK && age <= this.staleMs();
      const newer = station.sampleAt === null || record.sampleAt > station.sampleAt;
      if (!usable) {
        station.error = 'stale';
        station.reading = undefined;
      } else {
        station.error = undefined;
        if (newer) {
          station.reading = {
            values: record.values,
            sampleAt: record.sampleAt,
            age: Math.max(0, age),
            readAt: mono,
          };
          station.sample = record.sample;
          station.sampleAt = record.sampleAt;
          station.changedAt = now;
          fresh.push(station);
        }
      }
      this.store.saveStation(this.saved(station), configured);
    }
    for (const key of configured) {
      if (!records.some((r) => r.key === key)) {
        // Configured, found before, not in this answer (deleted meanwhile).
        const station = this.stations.get(key);
        if (station) {
          station.error = 'stale';
        }
      }
    }
    await this.publishDiscovered();
    for (const station of fresh) {
      // Disconnected or reconfigured meanwhile: nothing more is published.
      if (generation !== this.generation) {
        return;
      }
      await this.publishReading(station);
    }
  }

  /** A station as kept under /data (nothing secret). */
  saved(station) {
    return {
      key: station.key,
      id: station.id,
      name: station.name,
      fields: [...station.fields],
      sample: station.sample,
      sampleAt: station.sampleAt,
      changedAt: station.changedAt,
      seenAt: station.seenAt,
    };
  }

  // --- Gladys devices and states --------------------------------------------------

  /** The stations configured now, known by their key. */
  current() {
    return this.configuredKeys()
      .map((key) => this.stations.get(key))
      .filter(Boolean);
  }

  devices() {
    return this.current()
      .map((station) =>
        deviceOf(this.gladys, {
          stationKey: station.key,
          name: `Trafikverket ${station.name}`,
          fields: station.fields,
        }),
      )
      .filter((device) => device.features.length > 0);
  }

  /** The Discovery tab, published again only when it changed. */
  async publishDiscovered({ force = false } = {}) {
    const devices = this.devices();
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDiscovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.lastDiscovered = key;
    } catch (err) {
      this.logger.warn(`publishDiscoveredDevices failed: ${err.message}`);
    }
  }

  /** A reading still within the stale limit, measured on the monotonic clock. */
  isFresh(station) {
    const reading = station?.reading;
    return Boolean(reading) && reading.age + (this.monotonic() - reading.readAt) <= this.staleMs();
  }

  /**
   * The values of a new measurement, for the created features only
   * (`only`: the features of one device just created). At most
   * MAX_STATIONS × FIELDS.length = 85 states per read, under the 300 states
   * per minute of the core.
   */
  async publishReading(station, only) {
    if (!this.isFresh(station)) {
      return;
    }
    const created = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        created.add(feature.external_id);
      }
    }
    const states = statesOf(this.gladys, {
      stationKey: station.key,
      values: station.reading.values,
    }).filter(
      (s) =>
        created.has(s.device_feature_external_id) &&
        (only === undefined || only.has(s.device_feature_external_id)),
    );
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: HEARTBEAT });
    } catch (err) {
      // Not sent again: the next measurement brings newer values.
      this.logger.warn(`Publishing the states failed: ${err.message}`);
    }
  }

  /** A device was created: its values now, if the last measurement is still fresh. */
  async onDeviceCreated(device) {
    const prefix = this.gladys.externalIds(DEVICE_TYPE, '').device;
    const id = String(device?.external_id ?? '');
    if (!id.startsWith(prefix)) {
      return;
    }
    const station = this.stations.get(id.slice(prefix.length));
    if (!station || !this.configuredKeys().includes(station.key)) {
      return;
    }
    const only = new Set((device.features ?? []).map((f) => f.external_id));
    await this.publishReading(station, only);
  }

  // --- Status ------------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The notes added to a status: ignored entries, entries not found, a refusal. */
  notes() {
    const notes = [];
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidSlots(this.config.invalid));
    }
    if (this.resolved.size > 0) {
      const missing = [];
      for (const { slot } of this.config.stations) {
        const resolved = this.resolved.get(slot);
        if (resolved && resolved.keys.length === 0 && resolved.ambiguous.length === 0) {
          missing.push(slot);
        } else if (resolved?.ambiguous.length > 0) {
          notes.push(T.ambiguous({ slot, ids: resolved.ambiguous }));
        }
      }
      if (missing.length > 0) {
        notes.push(T.missing(missing));
      }
    }
    if (this.error === 'refused') {
      notes.push(T.refusedHelp);
    }
    return notes;
  }

  withNotes(text) {
    const notes = this.notes();
    if (notes.length === 0) {
      return text;
    }
    return {
      en: `${text.en} ${notes.map((n) => `${n.en.replace(/\.$/, '')}.`).join(' ')}`,
      fr: `${text.fr} ${notes.map((n) => `${n.fr.replace(/\.$/, '')}.`).join(' ')}`,
    };
  }

  /** What has no value, and why: [{ name, kind }]. */
  failing() {
    const list = [];
    if (this.error) {
      list.push({ name: 'Trafikverket', kind: this.error });
    }
    for (const station of this.current()) {
      if (station.error) {
        list.push({ name: station.name, kind: station.error });
      }
    }
    return list;
  }

  configMessage() {
    const { config } = this;
    if (config.keyInvalid) {
      return T.keyInvalid;
    }
    if (!config.apiKey && config.stations.length === 0) {
      return T.notConfigured;
    }
    if (!config.apiKey) {
      return T.noKey;
    }
    if (config.stations.length === 0) {
      return T.noStation;
    }
    return null;
  }

  async refreshStatus() {
    const missing = this.configMessage();
    if (missing) {
      return this.setStatus(false, this.withNotes(missing));
    }
    const failing = this.failing();
    const anyValue = this.current().some((station) => this.isFresh(station));
    const text = T.ok({
      stations: this.current().length,
      interval: this.config.pollMinutes,
      failing,
    });
    const connected = this.error !== 'refused' && (anyValue || failing.length === 0);
    return this.setStatus(connected, this.withNotes(text));
  }

  // --- Configuration screen button -------------------------------------------------

  stationLine(station, lang) {
    const colon = lang === 'fr' ? ' :' : ':';
    if (!this.isFresh(station)) {
      const why = station.error
        ? reason(station.error)[lang]
        : lang === 'fr'
          ? 'pas de nouvelle mesure depuis le démarrage'
          : 'no new measurement since the start';
      return `- ${station.name} (${station.id})${colon} ${why}`;
    }
    const values = station.reading.values;
    const parts = [];
    const add = (key, unit) => {
      if (typeof values[key] === 'number') {
        const line = FIELDS.find(([k]) => k === key);
        const label = (lang === 'fr' ? line[5] : line[4]).toLowerCase();
        parts.push(`${label} ${numberText(values[key], lang)}${unit}`);
      }
    };
    add('air_temperature', ' °C');
    add('road_temperature', ' °C');
    add('wind_speed', ' m/s');
    add('precipitation', ' mm/h');
    if (values.road_ice === 1) {
      parts.push(lang === 'fr' ? 'glace sur la route' : 'ice on the road');
    }
    const age = station.reading.age + (this.monotonic() - station.reading.readAt);
    const minutes = Math.max(0, Math.round(age / 60_000));
    parts.push(lang === 'fr' ? `mesure d'il y a ${minutes} min` : `measured ${minutes} min ago`);
    return `- ${station.name} (${station.id})${colon} ${parts.join(', ')}`;
  }

  lines(lang) {
    const colon = lang === 'fr' ? ' :' : ':';
    const head = [];
    const pace = this.store.get();
    if (this.error) {
      head.push(reason(this.error)[lang]);
      if (pace.pausedUntil > this.now()) {
        head.push(T.pausedUntil(pace.pausedUntil)[lang]);
      }
    } else {
      head.push(`${this.current().length} station(s)`);
    }
    head.push(T.nextRead(this.nextRead())[lang]);
    const lines = [`Trafikverket${colon} ${head.join(', ')}`];
    for (const station of this.current()) {
      lines.push(this.stationLine(station, lang));
    }
    return lines;
  }

  async testConnection() {
    const missing = this.configMessage();
    if (missing) {
      return this.withNotes(missing);
    }
    // Gladys waits up to 120 s for the answer: past TEST_DEADLINE, the last
    // values are shown (a read still running finishes in the background).
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, TEST_DEADLINE);
    });
    try {
      await Promise.race([this.tick({ manual: true }), timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
    await this.publishDiscovered();
    await this.refreshStatus();
    return this.withNotes({ en: this.lines('en').join('\n'), fr: this.lines('fr').join('\n') });
  }
}
