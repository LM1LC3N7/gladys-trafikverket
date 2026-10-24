// -----------------------------------------------------------------------------
// The instant of a measurement (`Observation.Sample`). Trafikverket writes it
// with its offset ("2026-10-24T13:30:00.000+02:00"); pytrafikverket reads a
// time without offset as Swedish local time (Europe/Stockholm), and so does
// this. Anything else is unreadable (null): such a measurement is never
// published, since its age is unknown.
// -----------------------------------------------------------------------------

const SAMPLE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-]\d{2}:\d{2})?$/;

const STOCKHOLM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The offset of Stockholm (ms) at the instant `ms`. */
export function stockholmOffset(ms) {
  const parts = Object.fromEntries(
    STOCKHOLM.formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  const local = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return local - Math.floor(ms / 1000) * 1000;
}

/** A wall-clock time of Stockholm -> its instant (the later one in the autumn hour). */
function fromStockholm(wall) {
  const first = wall - stockholmOffset(wall);
  return wall - stockholmOffset(first);
}

/** `Observation.Sample` -> ms since the epoch, or null. */
export function parseSample(text) {
  const m = typeof text === 'string' ? SAMPLE.exec(text.trim()) : null;
  if (!m) {
    return null;
  }
  const [, y, mo, d, h, mi, s = '0', frac = '0', zone] = m;
  const fields = [y, mo, d, h, mi, s].map(Number);
  if (
    fields[1] < 1 ||
    fields[1] > 12 ||
    fields[2] < 1 ||
    fields[2] > 31 ||
    fields[3] > 23 ||
    fields[4] > 59 ||
    fields[5] > 59
  ) {
    return null;
  }
  const ms = Math.floor(Number(`0.${frac}`) * 1000);
  const wall = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5], ms);
  // Date.UTC rolls 31 February over to March: refused.
  if (new Date(wall).getUTCDate() !== fields[2]) {
    return null;
  }
  if (zone === undefined) {
    return fromStockholm(wall);
  }
  if (zone === 'Z') {
    return wall;
  }
  const sign = zone[0] === '-' ? -1 : 1;
  const [oh, om] = zone.slice(1).split(':').map(Number);
  if (oh > 14 || om > 59) {
    return null;
  }
  return wall - sign * (oh * 60 + om) * 60_000;
}
