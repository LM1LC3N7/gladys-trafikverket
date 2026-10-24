# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real key of the open API: the
      device of the Discovery tab, its values, the status, the test button,
      a wrong key, a station name shared by several stations. Never done
      yet.
- [ ] Run the store validator with the image check once the image is
      published.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.

## To confirm with a real key

- [ ] The answer of `data.json` for `WeatherMeasurepoint` 2.1: the JSON
      shape (`RESPONSE.RESULT[0].WeatherMeasurepoint[]`), whether `Wind` is
      a list (one per height; the first is read) or an object, and the
      form of `Observation.Sample` (with an offset is expected; without, it
      is read as Stockholm time, as pytrafikverket does).
- [ ] What the API answers to a wrong key (401 is expected, as
      pytrafikverket handles it; 403 is treated the same), and past its
      rate limit (429? `Retry-After`?).
- [ ] Whether the `EQ` filter on `Name` ignores case (the entries are
      matched without case on our side, but the API may not return a
      station typed in another case).
- [ ] The station ids: `SE_STA_VVIS` followed by digits is expected.

## Waiting for the Gladys core

- [ ] The kind of precipitation (`Observation.Weather.Precipitation`: no,
      rain, freezing rain, snow, sleet) has no category; the rain flag of
      30 minutes is published as a `rain-sensor`, the snowfall as a binary
      `unknown` sensor. Ice, snow and water on the road too (no road
      condition category).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-trafikverket:0.1.0`); the first patch release
  gives 0.1.1.
- **Reference**: pytrafikverket (MIT, Copyright (c) 2017 Peter Andersson,
  main branch, commit d02a081, read on 2026-10-24; license read in its
  LICENSE file), cloned read only in `~/code/ref/lot15/pytrafikverket`.
  Ported to JavaScript (the query, the weather fields, their reading),
  credited in the docs and in `THIRD_PARTY_NOTICES.md` with its MIT notice
  (copied into the image with `LICENSE`). Neighbour modules:
  gladys-weatherlink (pace, store, status, test button, tests) and
  gladys-tomtom-travel-time (cloud key of the user).
- **JSON answer, XML query**: the API takes the query only in XML; the
  answer is asked in JSON (`data.json`, documented by Trafikverket) so no
  XML parser ever reads a hostile answer (JSON.parse is linear). Every text
  of the query is escaped (all five entities); the key must match
  `[A-Za-z0-9_-]{8,128}` and a station entry must hold no control
  character, else they are refused before any request.
- **Read only**: one POST (the query), no command, no switch. Trains,
  ferries and cameras of Trafikverket are left out (other tracker ideas).
- **One request for all the stations** (up to five), every 10 minutes by
  default (5 to 60): the stations measure every 10 to 30 minutes.
- **Refused key = final stop** (lot 12/13 lesson): persisted with a salted
  scrypt fingerprint of the refused key (a 32-digit hexadecimal key: no
  brute force), no automatic retry; lifted by another key (tried a minute
  after the last request) or by a test button that succeeds (it reads only
  once the interval has passed).
- **Freshness** (lessons 12 and 28): the raw `Observation.Sample` and its
  instant are kept per station in `/data` with the instant of their change;
  a measurement is published only when strictly newer and at most
  `clamp(2 × interval, 1 h, 2 h)` old, the age taken on the `Date` header
  of the answer (else the local clock), then carried on the monotonic
  clock. States go through `publishChangedStates` (heartbeat 30 minutes)
  only when a new measurement arrives; no date is sent (a dated state does
  not trigger scenes). A device created later gets the last measurement only
  if it is still fresh. If the container is killed (not stopped) within the
  minute after a read, the last sample may not be on disk: the next read
  could publish that same measurement once more (still fresh, never older
  than the limit).
- **Identity**: the external id is the station id of Trafikverket in lower
  case (`station:se_sta_vvis…`), never its name; the configured entries are
  matched by id or name, case aside. A name matching several stations is
  refused and their ids listed. A configured entry is never echoed in the
  status (only its number).
- **Units**: °C (air: decimal sensor; road surface and dew point: probes,
  out of the room average), %, m/s (the native unit, listed by the core),
  degree, mm/h, m and mm (`distance-sensor`). Out-of-range values are
  dropped, never clamped.
- **State budget**: at most 5 × 17 = 85 states per read, far under the 300
  per minute of the core; no backlog needed.
- **Status and Discovery republished at each `connected`**; a reconnection
  keeps the pace, the pause and the refusal.
