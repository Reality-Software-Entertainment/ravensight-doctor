# Changelog

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
  off or a refused request exits 1. JSON gains a `live` object.
* Root `.gitignore` support (basename, anchored, `*`, `?`, `**`, trailing
  `/`), `--no-gitignore`, and repeatable `--ignore <pattern>`.
* `ravensight.config.json` with `trackFunctions`, `ignore` and `gitignore`.
  A broken file exits 2.
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
