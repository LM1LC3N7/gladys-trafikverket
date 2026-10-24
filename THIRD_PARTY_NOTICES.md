# Third-party notices

This integration is licensed under Apache-2.0 (see `LICENSE`). It ports to
JavaScript parts of the following project, under the MIT license.

## pytrafikverket

- Project: https://github.com/gjohansson-ST/pytrafikverket (the Python
  library the Trafikverket integration of Home Assistant uses; main branch,
  commit d02a081, read on 2026-10-24)
- Ported: the query of the open API of Trafikverket (`trafikverket.py`:
  the `REQUEST` / `LOGIN authenticationkey` / `QUERY` / `INCLUDE` / `FILTER`
  form, the API URL), the weather station query (`trafikverket_weather.py`:
  the `WeatherMeasurepoint` object, schema version 2.1, the station asked by
  name, the `Deleted` filter), the fields read (`const.py`:
  `WEATHER_REQUIRED_FIELDS`) and their reading (`helpers.py`:
  `weather_from_xml_node`, the precipitation of 30 minutes doubled into
  mm/h, a time without offset read as Swedish time).
- Changes: rewritten in JavaScript; the answer is asked in JSON
  (`data.json`) and parsed without an XML parser; every text entering the
  query is XML-escaped and a control character refused; the station asked by
  name or by id, several at once; read only; answers bounded in size; the
  key never logged; the snow depth read at `Surface.SnowDepth.Solid.Value`;
  trains, ferries and cameras left out.
- License: MIT, reproduced below.

```
MIT License

Copyright (c) 2017 Peter Andersson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
