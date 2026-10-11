# Changelog

## 0.3.0

Tests, docs and comments no longer count as track calls, and a project where
the doctor cannot read a large share of the event names is no longer called
healthy.

Upgrading: an existing project with many variable or concatenated event
names may move from `pass` or `warn` to `inconclusive`, which fails
`--strict`. Name your wrapper with `--track-fn`, or pass literal names.

### Added

* `tracking_unresolved` warning: lists up to 20 track calls (file:line) whose
  event name is not a string literal on the call line.
* The status is `inconclusive` when unresolved calls are 25 percent or more of
  all recognised track calls, as well as when no call has a literal name.
  `--strict` exits 1 on both.
* `--track-fn name@N` (and `"name@N"` in `trackFunctions`) reads the event
  name from argument N, 0 to 9. The `{ "name", "argIndex" }` object form
  stays.
* Lua method names in track function specs: `telemetry:track` matches
  `telemetry:track(` and `telemetry.track(`.
* `--include-tests` and `--include-docs`, and the GitHub Action inputs
  `include-tests` and `include-docs`.
* The inventory reports `filesScannedForCalls` and `filesScannedForKeys`, and
  the header prints both, plus one line naming what was left out
  (`filesLeftOutOfCallScan`). A call inside the body of your own named track
  function (found by the name's last segment) that passes its parameter on
  is counted as forwarded (`forwardedCalls`), not unresolved.

### Changed

* Track calls are no longer looked for in test paths, docs (`.md .mdx .rst
  .txt .html .htm`, `docs`, `doc`, `examples`, `example`), test directories
  (`test`, `tests`, `spec`, `specs`, `__tests__`, `fixtures`,
  `__fixtures__`, `__mocks__`) or vendored SDK directories named
  `ravensight`. Key checks still scan every file.
* Comments are blanked out before calls are matched: `//` and `/* */` for
  the C family, JavaScript, TypeScript, C#, Swift, Kotlin, Java and Odin, `#`
  for GDScript, Python, Ruby and shell, `--` and `--[[ ]]` for Lua. Line
  numbers are unchanged, and a key inside a comment is still reported. A
  `/*` inside a regex literal does not open a block comment.
* Test paths now include `spec` and `specs`, and test and docs directory
  names match in any case, for key hygiene and the call scan alike.
* `ravensight*.lua` files count as SDK files, like the other engines' SDK
  files, so their bodies are not scanned for calls.
* Lua function definitions (`function x.track(`, `function x:track(`,
  `local function track(`) are not counted as calls.
* A call matched by two forms is counted once, credited to the most
  specific (longest) form, so a bare `track` spec no longer double counts
  `rs.track(`, and is not reported as `track_fn_unused` when it matched.

## 0.2.0

The doctor now says when it cannot see your tracking instead of calling the
project healthy, and it can prove the ingest key works end to end.

### Added

* `inconclusive` status and the `tracking_unverified` warning. It fires when
  track calls exist but none names its event with a string literal, or when
  the project has an ingest key but no track call the doctor recognises.
  Precedence is fail, inconclusive, warn, pass. It exits 0 unless `--strict`.
* `--strict`: exit 1 on any status but `pass`.
* `--track-fn name[,name]` (repeatable) and `trackFunctions` in the new
  `ravensight.config.json` to count your own track functions, including
  dotted names such as `Analytics.logEvent` and `{ "name": ..., "argIndex": n }`
  for a name in a later argument. An unused one is the info `track_fn_unused`.
* An inventory in every report: track calls with file, line, form and literal
  name, event name counts, unresolved calls, track functions and ingest key
  counts. Printed as a summary and included in full in `--json`.
* `--live`: sends one `ravensight_doctor_ping` event through a doctor session
  and polls `GET /api/v1/doctor/ping/<nonce>` for up to 20 seconds. Not read
  back is the warning `live_ping_unconfirmed`; a bad key, tracking switched
  off, a refused request or no network is the error `live_check_failed` and
  exits 1. JSON gains a `live` object.
* Root `.gitignore` support (basename, anchored, `*`, `?`, `**`, trailing
  `/`, and `!` lines that keep a path scanned), `--no-gitignore`, and
  repeatable `--ignore <pattern>`.
* `ravensight.config.json` with `trackFunctions`, `ignore` and `gitignore`.
  Invalid JSON or a wrong type on a known key exits 2; unknown keys are
  ignored with one note on stderr.
* GitHub Action inputs `strict`, `live` and `track-fn`.

### Changed

* Member track calls match when the name right before `.track(` is exactly
  `rs`, `ravensight` or `Ravensight`, with any chain before it, so
  `this.rs.track(` and `window.rs.track(` now count. Every call on a line is
  recorded, and function definitions are not counted as calls.
* The ingest key pattern is exactly `gt_live_` plus 32 characters of
  `[A-Za-z0-9_-]`. Keys under test, fixture and mock paths, or in `*.test.*`
  and `*.spec.*` files, never satisfy `no_ingest_key` and are never used for
  `--report` or `--live`.
* "Your integration looks healthy" prints only on a real `pass`.
* More directories are skipped (`coverage`, `.playwright-mcp`, `.cache`,
  `.next`, `.nuxt`, `.turbo`, `.vite`, `.svelte-kit`, `tmp`), and images,
  fonts, media, archives, compiled output, source maps, minified files, logs
  and lockfiles are never opened. Each file is read from disk once per scan,
  and binary detection reads only the first 8000 bytes.
* `--report` sends `inconclusive` as `warn`, and never sends the inventory or
  the live result.

## 0.1.1

* Published to npm with `npx` commands and a tag triggered publish workflow.

## 0.1.0

* First release: the static integration linter CLI, GitHub Action and GitLab
  CI docs.
