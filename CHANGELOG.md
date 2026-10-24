# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-24

### Added

- The road weather stations of Trafikverket (Sweden) in Gladys, read only
  through the official open API with your own free key: air and road
  temperature, dew point, humidity, visibility, wind, gusts, precipitation,
  rain and snowfall, ice, snow and water on the road. Up to five stations,
  by name or id, one request per interval (10 minutes by default).
- Only fresh measurements are published (newer than the last one, at most
  one hour old); a clean restart does not publish the last one again (a
  hard stop within the minute after a read may publish it once more, never
  past the age limit).
- A refused key stops the reads until the key changes or the test button
  succeeds; 429/5xx pause the reads (1 minute to 6 hours). The key is never
  logged nor written under `/data`.

[Unreleased]: https://github.com/LM1LC3N7/gladys-trafikverket/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-trafikverket/releases/tag/v0.1.1
