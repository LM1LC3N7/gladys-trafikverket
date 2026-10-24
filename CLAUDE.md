# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for the road weather stations
of Trafikverket (Sweden), read only through the official open API: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
The query and the fields are ported from pytrafikverket (MIT, see
`THIRD_PARTY_NOTICES.md`).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "refused" # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        TrafikverketApp: pace, pause, refusal, freshness, devices, states, status, test
src/trafikverket.js               the XML query (escaped), the JSON answer, error kinds
src/fields.js                     Observation -> values in core units, devices, states (pure)
src/time.js                       Observation.Sample -> instant (offset, else Europe/Stockholm)
src/store.js                      pace, pause, refusal, stations and last samples, in /data (never the key)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/http.js                       fetch with timeout, no redirection, bounded body (the one POST)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
.github/scripts/cover.mjs         draws cover.png with Node alone
```

## Rules

- **Read only.** One request: the `WeatherMeasurepoint` query of the open
  API. Never trains, ferries nor cameras (out of scope).
- **The API key** travels only in the XML body of that request, to
  `api.trafikinfo.trafikverket.se`; everything entering the XML is escaped
  (`xmlEscape`) and the key must match `[A-Za-z0-9_-]{8,128}`. Never the key
  in a log, an error, a status nor `/data` (only a salted scrypt fingerprint
  while it is refused). Never describe a secret field as "encrypted": Gladys
  keeps it in clear in its database (`test/manifest.test.js` checks it).
- **Refused key = final stop**, persisted; no automatic retry. Lifted by
  another key, or by a successful test button. 429/5xx: bounded pause,
  persisted.
- **Pace.** Never read before the last request + the interval (test button,
  reconnection, saved configuration, Discovery, restart); the instant of a
  request is written to `/data` before it leaves, at most once per minute.
- **Freshness.** Publish a measurement only if newer than the last one
  published for that station (kept in `/data`) and within the stale limit
  (1 to 2 hours), on the clock of the service then on the monotonic clock.
  Never publish an old measurement again as new.
- **External ids are forever.** `station:<Trafikverket station id in lower
case>`, then the feature keys of `FIELDS` (`road_temperature`...), never an
  API path. The same goes for every key users store: manifest
  `config_schema`, `actions`.
- **Units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY`), read-only
  features, never a switch; never drop a feature of a created device from
  the Discovery list.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (the first version, 0.1.0, was set by hand once, see TODO.md).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language; no
  `default` on a secret field.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
