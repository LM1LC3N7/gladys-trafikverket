# gladys-trafikverket

[Gladys Assistant](https://gladysassistant.com) external integration for the
**road weather stations of Trafikverket** (the Swedish Transport
Administration): air and road surface temperature, dew point, humidity,
wind, precipitation, ice, snow and water on the road, read through the
official open API of Trafikverket with the user's own free key. Read only.
**Unofficial, not affiliated with Trafikverket. Never tested with a real key
yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (TrafikverketApp)  pace, pause, refusal, freshness, devices, states, status, test button
                 ├─ src/trafikverket.js       the XML query (escaped), the JSON answer, error kinds
                 ├─ src/fields.js             Observation -> values in core units, devices, states (pure)
                 ├─ src/time.js               Observation.Sample -> instant (offset, else Stockholm time)
                 ├─ src/store.js              pace, pause, refusal, stations met and last samples, in /data
                 ├─ src/config.js             DEFAULT_CONFIG + normalization of the configuration
                 └─ src/http.js               fetch, timeout, no redirection, bounded body
```

- **One request** per interval for up to five stations:
  `POST https://api.trafikinfo.trafikverket.se/v2/data.json`, the query of
  the API in XML (`WeatherMeasurepoint`, schema 2.1, `Deleted` = false, each
  entry asked by `Id` and by `Name`), the key in `LOGIN authenticationkey`.
  Every text entering the XML is escaped; a key outside `[A-Za-z0-9_-]` and
  a station name with a control character are refused before. The answer is
  JSON, bounded to 256 KB.
- **Pace**: 10 minutes by default (5 to 60); never faster than the interval
  since the last request (persisted before it leaves, written at most once
  per minute), test button, reconnections and restarts included; a new key a
  minute after the last request.
- **Refused key** (401/403): final, persisted, never retried by itself;
  lifted by another key, or by a successful test button once the interval
  has passed. **429/5xx**: `Retry-After`, else 5 minutes doubling, between
  1 minute and 6 hours, persisted. The file
  `/data/trafikverket-state.json` never holds the key (only while it is
  refused, a salted scrypt fingerprint of it).
- **Freshness**: a measurement is published only if newer than the last one
  published for the station (kept in `/data`) and at most 1 hour old (2
  intervals if longer, 2 hours at most), on the clock of the service (`Date`
  header), then on the monotonic clock.
- **Devices**: one per station, `station:<station id in lower case>`, then a
  feature key of this integration (`road_temperature`, `road_ice`...). Units
  of the core only; read-only sensors; a feature once created is never
  dropped from the Discovery list.

No runtime dependency besides the Gladys SDK. Trains, ferries and cameras
of Trafikverket are out of scope.

## Development

```bash
npm install
npm test                                        # node --test, no network, no disk
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
node .github/scripts/cover.mjs                  # draws cover.png (no dependency)
```

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## Credits

[pytrafikverket](https://github.com/gjohansson-ST/pytrafikverket) (MIT): the
query of the open API and the fields of the weather stations. Its notice is
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0 ([LICENSE](LICENSE)). Trafikverket is a Swedish government agency;
this project is not affiliated with it.
