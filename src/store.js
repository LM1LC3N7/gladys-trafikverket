// -----------------------------------------------------------------------------
// What must survive a restart of the container (a file under /data): the
// instant of the last request, the end of a pause (429/5xx), a refusal of
// the key, and for each station met its id, its name, the fields it gave
// (nothing secret: the Discovery list is not empty after a restart) and its
// last measurement published (the raw `Observation.Sample`, its instant and
// when it changed), so a restart never publishes an old measurement again as
// a new one.
//
// The instant of a request is written at most once per minute (WRITE_GAP
// after the previous write, whatever it was; the instant of the write is
// kept in the file): a read waits until such a write is allowed, so the
// instant of its request is always on disk before the request leaves. A
// pause, a refusal or its end is written at once (one such write per
// request at most), so a restart never forgets it.
//
// The key is never written. Only while it is refused, the file keeps a
// salted scrypt fingerprint (16 bytes, a random salt per file) of that
// refused key, to know after a restart whether the refusal still concerns
// the configured key; it is erased by the first successful read. Nothing in
// the file can confirm a key that works. (A key of the portal is 32
// hexadecimal digits: no brute force of the fingerprint is possible.)
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_STATIONS, WRITE_GAP } from './constants.js';
import { FIELD_KEYS } from './fields.js';
import { cleanText } from './trafikverket.js';

/** At most this many stations kept in the file (the configured ones first). */
export const MAX_SAVED_STATIONS = 2 * MAX_STATIONS;

/** A storage in memory (tests, and the fallback). */
export function memoryStorage(initial) {
  let value = initial;
  return {
    writes: 0,
    load: () => value,
    save(next) {
      this.writes += 1;
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

/**
 * A JSON file, written atomically (a .tmp file, then a rename). A missing or
 * unreadable file is a first start (warned once, without its content); a
 * write failure is warned once: memory only then.
 */
export function fileStorage(path, { logger } = {}) {
  const warned = new Set();
  const warnOnce = (kind, text) => {
    if (!warned.has(kind)) {
      warned.add(kind);
      logger?.warn?.(text);
    }
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnOnce('read', `State file unreadable (${err.code ?? 'error'}): starting afresh`);
        }
        return undefined;
      }
      if (text.length > 128 * 1024) {
        warnOnce('read', 'State file too large: starting afresh');
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch {
        warnOnce('read', 'State file corrupt: starting afresh');
        return undefined;
      }
    },
    save(value) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
      } catch (err) {
        warnOnce('write', `State file not writable (${err.code ?? 'error'}): kept in memory`);
      }
    },
  };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const STATION_KEY = /^[a-z0-9_.-]{1,64}$/;
const STATION_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** A station read back from the file, or undefined when it does not look right. */
function stationOf(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  if (!STATION_ID.test(value.id) || !STATION_KEY.test(value.key)) {
    return undefined;
  }
  if (value.id.toLowerCase() !== value.key) {
    return undefined;
  }
  return {
    key: value.key,
    id: value.id,
    name: cleanText(value.name, 60) || value.id,
    fields: Array.isArray(value.fields)
      ? [...new Set(value.fields.filter((f) => typeof f === 'string' && FIELD_KEYS.has(f)))]
      : [],
    // The instant of the last sample is kept as the service gave it (the
    // clock of Gladys may lag behind the service): only an absurd one, more
    // than a day ahead, is dropped with its raw text.
    ...(typeof value.sampleAt === 'number' &&
    Number.isFinite(value.sampleAt) &&
    value.sampleAt <= now + SAMPLE_AHEAD_MAX
      ? {
          sample: typeof value.sample === 'string' ? value.sample.slice(0, 40) : '',
          sampleAt: value.sampleAt,
        }
      : { sample: '', sampleAt: null }),
    changedAt: Math.min(finite(value.changedAt), now),
    seenAt: Math.min(finite(value.seenAt), now),
  };
}

/** A sample instant read back more than this ahead of the clock is absurd. */
const SAMPLE_AHEAD_MAX = 24 * 60 * 60_000;

const defaultMonotonic = () => performance.now();

export class StateStore {
  constructor({
    storage = memoryStorage(),
    now = Date.now,
    monotonic = defaultMonotonic,
    timers = { setTimeout, clearTimeout },
    maxPause,
  }) {
    this.storage = storage;
    this.now = now;
    this.monotonic = monotonic;
    this.maxPause = maxPause;
    this.timers = timers;
    this.flushTimer = undefined;
    this.dirty = false;
    /** In memory only: the key last configured, to tell a change. */
    this.key = undefined;
    const saved = storage.load();
    const valid = saved && typeof saved === 'object' && !Array.isArray(saved);
    const at = now();
    const mono = monotonic();
    this.salt =
      valid && typeof saved.salt === 'string' && /^[0-9a-f]{32}$/.test(saved.salt)
        ? saved.salt
        : randomBytes(16).toString('hex');
    // In memory, every deadline (last request, end of a pause, last write)
    // is held on the monotonic clock: a wall clock that jumps (NTP, a wrong
    // RTC) neither freezes the reads nor shortens or stretches a pause. The
    // wall clock only serves the file (written from the monotonic deadlines)
    // and the restart. The instant of the last write is never in the
    // future: a restart loop writes no more often than a running process.
    this.writtenMono = valid ? mono - (at - Math.min(finite(saved.writtenAt), at)) : -Infinity;
    const pace = valid && saved.pace && typeof saved.pace === 'object' ? saved.pace : {};
    // A time read back is capped (a request never "in the future", a pause
    // never longer than a fresh one): a clock that jumped, or a hand-edited
    // file, never stops the integration for longer.
    const refused = pace.refused === true;
    const lastAttemptAt = Math.min(finite(pace.lastAttemptAt), at);
    this.pace = {
      attemptMono: lastAttemptAt > 0 ? mono - (at - lastAttemptAt) : -Infinity,
      pausedMono: mono + clamp(finite(pace.pausedUntil) - at, 0, maxPause),
      streak: Math.min(Math.max(0, Math.floor(finite(pace.streak))), 20),
      refused,
      fp: refused && typeof pace.fp === 'string' && /^[0-9a-f]{32}$/.test(pace.fp) ? pace.fp : '',
    };
    /** station key -> station (as stationOf returns it) */
    this.stations = new Map();
    const list = valid && Array.isArray(saved.stations) ? saved.stations : [];
    for (const raw of list.slice(0, MAX_SAVED_STATIONS)) {
      const station = stationOf(raw, at);
      if (station && !this.stations.has(station.key)) {
        this.stations.set(station.key, station);
      }
    }
  }

  /** The salted fingerprint of a key (never the key). */
  fingerprint(key) {
    return scryptSync(String(key), `${this.salt}:api_key`, 16).toString('hex');
  }

  /** The pace as wall-clock instants (status, file), derived from the monotonic deadlines. */
  get() {
    const now = this.now();
    const mono = this.monotonic();
    return {
      lastAttemptAt: Number.isFinite(this.pace.attemptMono)
        ? now - (mono - this.pace.attemptMono)
        : 0,
      pausedUntil: this.pace.pausedMono > mono ? now + (this.pace.pausedMono - mono) : 0,
      streak: this.pace.streak,
      refused: this.pace.refused,
      fp: this.pace.fp,
    };
  }

  /** Time since the last request (monotonic); Infinity before the first one. */
  sinceAttempt() {
    return this.monotonic() - this.pace.attemptMono;
  }

  /** Time left in the pause (monotonic), never more than the longest pause. */
  pauseLeft() {
    return clamp(this.pace.pausedMono - this.monotonic(), 0, this.maxPause);
  }

  /** Time left before a write is allowed (monotonic). */
  writeWait() {
    return clamp(this.writtenMono + WRITE_GAP - this.monotonic(), 0, WRITE_GAP);
  }

  /**
   * The saved pace for the configured key. Another key lifts the refusal:
   * told apart in memory while the process runs; after a restart, only a
   * refused key is known (its fingerprint), so a key changed while the
   * container was stopped keeps the pace. Returns `{ pace, changed }`.
   */
  restore(key) {
    let changed = false;
    if (this.key !== undefined) {
      changed = this.key !== key;
    } else if (this.pace.refused && this.pace.fp) {
      changed = this.pace.fp !== this.fingerprint(key);
    }
    this.key = key;
    if (changed && this.pace.refused) {
      this.update({ refused: false });
    }
    return { pace: this.get(), changed };
  }

  /**
   * Update the pace. A refusal (`refused: true`, with the refused `key`)
   * keeps the fingerprint of that key; anything else erases it. A change (a
   * pause, a refusal, its end: rare events, one per request at most) is
   * written at once, so a restart never forgets it; with `defer` (the
   * instant of a request, written by its own flush), at the next allowed
   * instant.
   */
  update(changes, key, { defer = false } = {}) {
    const before = JSON.stringify(this.pace);
    const { lastAttemptAt, pausedUntil, ...rest } = changes;
    const next = { ...this.pace, ...rest };
    // Wall-clock instants given by the caller (`now` + a delay) become
    // monotonic deadlines at once.
    const now = this.now();
    const mono = this.monotonic();
    if (lastAttemptAt !== undefined) {
      next.attemptMono = mono - Math.max(0, now - lastAttemptAt);
    }
    if (pausedUntil !== undefined) {
      const pause = clamp(pausedUntil - now, 0, this.maxPause);
      // No pause: a deadline already past is kept as it is (no write for nothing).
      next.pausedMono = pause > 0 ? mono + pause : Math.min(this.pace.pausedMono, mono);
    }
    if (changes.refused === true && key !== undefined) {
      next.fp = this.fingerprint(key);
    } else if (!next.refused) {
      next.fp = '';
    }
    this.pace = next;
    if (JSON.stringify(next) !== before) {
      if (defer) {
        this.markDirty();
      } else {
        this.dirty = true;
        this.write();
      }
    }
    return this.get();
  }

  station(key) {
    return this.stations.get(key);
  }

  /**
   * Keep a station met (its fields only grow). `configured` are the keys of
   * the stations configured now: kept first when the file is full.
   */
  saveStation(station, configured = []) {
    const before = JSON.stringify(this.stations.get(station.key) ?? null);
    this.stations.set(station.key, { ...station, fields: [...station.fields] });
    if (this.stations.size > MAX_SAVED_STATIONS) {
      const drop = [...this.stations.values()]
        .filter((s) => !configured.includes(s.key))
        .sort((a, b) => a.seenAt - b.seenAt);
      while (this.stations.size > MAX_SAVED_STATIONS && drop.length > 0) {
        this.stations.delete(drop.shift().key);
      }
    }
    if (JSON.stringify(this.stations.get(station.key) ?? null) !== before) {
      this.markDirty();
    }
  }

  /** The first instant a write is allowed (wall clock, for the status). */
  writableAt() {
    return this.now() + this.writeWait();
  }

  canWrite() {
    return this.writeWait() === 0;
  }

  markDirty() {
    this.dirty = true;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer !== undefined) {
      return;
    }
    const delay = this.writeWait();
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  /** Write the file now if something changed and a write is allowed; returns whether it is on disk. */
  flush() {
    if (!this.dirty) {
      return true;
    }
    if (!this.canWrite()) {
      this.scheduleFlush();
      return false;
    }
    this.write();
    return true;
  }

  /** At the clean stop: write what is left, even within the minute (one write). */
  flushNow() {
    if (this.dirty) {
      this.write();
    }
  }

  write() {
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.writtenMono = this.monotonic();
    this.dirty = false;
    this.storage.save({
      salt: this.salt,
      writtenAt: this.now(),
      pace: this.get(),
      stations: [...this.stations.values()],
    });
  }

  /** Stop the pending write (the next start writes what is left). */
  close() {
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
}
