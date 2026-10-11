# Ravensight Doctor

Static integration linter for [Ravensight](https://ravensight.io) player
analytics SDKs.

Point it at a game project and it detects which engine and Ravensight SDK you
are using, checks the integration for the mistakes that actually cost people
data, prints a report, and can submit that report to your Ravensight
dashboard. Zero runtime dependencies, one command in CI.

* API base: `https://api.ravensight.io`
* Docs: https://ravensight.io/docs/
* Node 18 or newer

## Verification status

The checks are written and reviewed against the live
report API contract and covered by tests over fixture projects, but the
scanner is young and deliberately conservative: it is line based and prefers
missing a clever case over reporting a false positive. If it flags something
that is actually fine, or misses something it should have caught, please open
an issue with a snippet that reproduces it.

## What it checks

| Finding | Severity | What it means |
| --- | --- | --- |
| `sdk_missing` | error | An engine was detected but no Ravensight SDK is in the project. |
| `wrong_key_type` | error | A secret that must never ship in a game build (a `gt_mcp_` token, a Stripe live key, an AWS access key) is in the tree. Only a masked prefix is ever printed. |
| `event_name_too_long` | error | A track call uses an event name literal over 200 characters, which the server rejects. |
| `tracking_unverified` | warning | The doctor could not check your events: either it found track calls but none names its event with a string literal (usually a wrapper that passes a variable), or the project has an ingest key but no track call it recognises. Makes the status `inconclusive`. Name your wrapper with `--track-fn` to resolve it. |
| `tracking_unresolved` | warning | Some track calls do not name their event with a string literal on the call line, so those names were not checked. Lists up to 20 of them as file:line. When they are 25 percent or more of all recognised calls the status is `inconclusive`. A concatenated or interpolated name (`"level_" + str(n)`) counts as unresolved here and also keeps its `event_name_cardinality` warning. |
| `no_ingest_key` | warning | No `gt_live_` ingest key found outside test paths. Fine if you inject it at runtime, fatal if you forgot it. |
| `event_name_cardinality` | warning | An event name embeds a multi digit number or string interpolation or concatenation. Identifiers belong in event data, not names. |
| `large_inline_payload` | warning | An object literal inside a track call spans more than 8KB of source. The server caps event data at 8KB serialized. |
| `live_check_failed` | error | `--live` could not deliver its test event: no usable key, a rejected key, tracking switched off, a refused session or event, or no network. The note says which step failed. |
| `live_ping_unconfirmed` | warning | `--live` sent its test event and the API accepted it, but it was not read back within 20 seconds. |
| `no_track_calls` | info | The SDK is installed but nothing calls track yet, and no ingest key is wired up either. |
| `track_fn_unused` | info | A track function you named with `--track-fn` or `trackFunctions` is never called. Check the spelling. |
| `flush_on_exit_missing` | info | A hand rolled integration has track calls but no flush or exit handling, so the last batch is lost on quit. SDK engines handle this themselves and never get this finding. |

Engines detected: Godot, Unreal, Unity, iOS, Android, JavaScript, Odin, C++,
and `custom` for everything else. Detection is first match wins, and the whole
tree is scanned either way.

### Status

The report status is one of four values, in this order of precedence:

| Status | When |
| --- | --- |
| `fail` | At least one error finding. |
| `inconclusive` | A `tracking_unverified` finding (no literal event names at all), or unresolved calls making up 25 percent or more of the recognised track calls. Either way the doctor could not see enough of how your project tracks events for a clean result to mean anything. |
| `warn` | Any other warning. |
| `pass` | No errors or warnings. Only a real pass prints "Your integration looks healthy." |

### Inventory

Every report lists what the doctor actually recognised: each track call with
its file, line, call form and literal event name (or none when the name is a
variable), the distinct event names with their counts, the number of
unresolved calls, the track functions it looked for with their call counts,
how many ingest keys it found in the project and under test paths, and how
many files it scanned for calls (`filesScannedForCalls`) and for keys
(`filesScannedForKeys`). The pretty report prints a summary and `--json`
prints all of it.

A call inside one of your own named track functions that just passes the
function's parameter on (`function logEvent(name) { rs.track(name) }`) is
counted as forwarded (`forwarded: true`, `forwardedCalls`), not unresolved,
because the names are checked where your function is called. The doctor
finds the definition by the last segment of the name you gave it
(`--track-fn Analytics.log_event` finds `func log_event(name):`) and only
counts calls inside its body: up to the closing brace in C style languages,
while the indentation lasts in GDScript and Python, and up to the matching
`end` in Lua. The same call anywhere else stays unresolved. A parameter list
that spans several lines is not followed.

### Which calls count as track calls

* Member calls where the name right before `.track(` is exactly `rs`,
  `ravensight` or `Ravensight`, with any chain before it: `rs.track(`,
  `this.rs.track(`, `window.rs.track(` and `Game.Ravensight.track(` all
  count, while `analytics.track(` and `myrs.track(` do not.
* `Ravensight.Track(` (Unity), `->Track(` (Unreal) and `track(client, ...)`
  (Odin, where the event name is the second argument).
* Your own functions, named with `--track-fn` or `trackFunctions` (see
  [Configuration](#configuration)). A plain name such as `capture` matches a
  call to it with or without a receiver. A dotted name such as
  `Analytics.logEvent` must match from its first segment, so
  `Game.Analytics.logEvent(` counts and `MyAnalytics.logEvent(` does not.
  A Lua method name such as `telemetry:track` (one `:` before the last
  segment) matches `telemetry:track(` and `telemetry.track(` both.
  Function definitions are not counted as calls, including Lua's
  `function x.track(`, `function x:track(`, `local function track(` and
  `function track(`.
* When two forms match the same call (for example `track` and the built in
  `rs.track` both match `rs.track(`), it is one call, credited to the most
  specific form, the one with the longest name.

Track calls inside the SDK's own files are ignored, so its doc comments do
not trip findings.

### Comments

Calls are matched after comments are blanked out, so a commented out call is
never counted. Line numbers are unchanged.

| Files | Comments removed |
| --- | --- |
| `.js .mjs .cjs .ts .tsx .jsx .cs .swift .kt .java .odin .c .cc .cpp .h .hpp` | `//` to the end of the line, and `/* ... */` |
| `.gd .py .rb .sh` | `#` to the end of the line |
| `.lua` | `--` to the end of the line, and `--[[ ... ]]` (also `--[==[ ... ]==]`) |
| anything else | nothing |

Known limit: quoted strings are only followed within one line, so a comment
marker inside a string that spans lines (a template literal, a Python triple
quoted string, a Lua long string) can be mistaken for a comment. A `/*` with
no `*/` on its line starts a block comment only at the start of a line or
after an operator, bracket or separator, so the `/*` in a regex literal such
as `/\/*$/` is read as code. Key checks
read the file as written, so a key inside a comment is still reported.

### Scan scope

Key checks (ingest keys, MCP tokens and other secrets) read every file the
walk below finds. Track calls are looked for in a narrower set, so tests and
documentation do not count as calls:

* Test paths are left out: files under `test`, `tests`, `spec`, `specs`,
  `__tests__`, `fixtures`, `__fixtures__` or `__mocks__` at any depth, and
  `*.test.*` and `*.spec.*` files. `--include-tests` brings them back.
* Docs are left out: `.md`, `.mdx`, `.rst`, `.txt`, `.html` and `.htm` files,
  and files under `docs`, `doc`, `examples` or `example` at any depth.
  `--include-docs` brings them back.
* A vendored copy of the SDK, any directory named `ravensight` (for example
  `lib/ravensight/`, `vendor/ravensight/`, `addons/ravensight/`) and any SDK
  file named `ravensight*`, is always left out.

Directory names match in any case, so Unity's `Assets/Tests` is a test path.
The header shows both counts and what was left out, for example:

```
  Files:   448 scanned for calls, 6432 scanned for keys
           5984 files left out of the call scan: tests, docs, vendored SDK; use --include-tests or --include-docs
```

What the walk skips for every check:

* Directories never scanned, at any depth: `node_modules`, `.git`, `.import`,
  `.godot`, `Library`, `Intermediate`, `DerivedData`, `build`, `dist`,
  `coverage`, `.playwright-mcp`, `.cache`, `.next`, `.nuxt`, `.turbo`,
  `.vite`, `.svelte-kit` and `tmp`.
* Files never opened: images, fonts, audio, video, archives, compiled
  output, source maps, coverage reports, minified `.min.js` and `.min.css`,
  logs, and lockfiles such as `package-lock.json`, `yarn.lock` and
  `pnpm-lock.yaml`. Binary files and files over 2MB are skipped too.
* The root `.gitignore` is honoured: basename patterns, patterns anchored by
  a slash, `*`, `?`, `**` and a trailing `/` for directories. A negated
  (`!`) line always keeps what it matches scanned, so `*.json` plus
  `!package.json` still scans `package.json`. Nested `.gitignore` files are
  not read. Pass
  `--no-gitignore` to scan ignored files anyway, for example when your
  ingest key lives in a gitignored file.
* `--ignore <pattern>` (repeatable) and `ignore` in the config file add
  patterns in the same syntax.

### Ingest key detection

A real ingest key is `gt_live_` followed by exactly 32 characters of letters,
digits, `_` or `-`. Keys found under `test`, `tests`, `spec`, `specs`,
`fixtures`, `__tests__`, `__fixtures__` or `__mocks__` directories (any
case), or in `*.test.*` and `*.spec.*` files, are counted as test keys. This
is the same test path list the track call scan leaves out. They are listed in the inventory but never
satisfy `no_ingest_key` and are never used for `--report` or `--live`. The
doctor never prints a key.

## Quickstart

From your project directory:

```bash
npx --yes ravensight-doctor
```

Or scan a specific path:

```bash
npx --yes ravensight-doctor path/to/game
```

Options:

| Flag | What it does |
| --- | --- |
| `--json` | Print the report as JSON to stdout, including the inventory and the live result. |
| `--report` | Also submit the report to the Ravensight API. |
| `--live` | Send one test event with the ingest key and confirm the API stored it. See [The live check](#the-live-check). |
| `--strict` | Exit 1 on any status but `pass`, including `warn` and `inconclusive`. |
| `--track-fn <name>` | Also count calls to your own track function. Comma separated and repeatable: `--track-fn capture,Analytics.logEvent`. A Lua method works as `telemetry:track`. Add `@N` when the event name is argument N (0 to 9): `--track-fn capture@1` for `capture(userId, "level_start")`. |
| `--include-tests` | Also look for track calls in test paths. Key checks always cover them. |
| `--include-docs` | Also look for track calls in Markdown, text and HTML files and in docs and examples directories. |
| `--ignore <pattern>` | Skip files matching a `.gitignore` style pattern. Repeatable. |
| `--no-gitignore` | Scan files the root `.gitignore` excludes. |
| `--key gt_live_...` | Ingest key for `--report` and `--live`. Falls back to the `RAVENSIGHT_INGEST_KEY` environment variable, then to the first `gt_live_` key found in the scanned project outside test paths. |
| `--api-url <url>` | Override the API base URL. Only for self hosting. |

## Configuration

Put a `ravensight.config.json` in the directory you scan to keep settings
with the project:

```json
{
  "trackFunctions": [
    "capture",
    "Analytics.logEvent",
    "telemetry:track",
    "capture@1",
    { "name": "track_event", "argIndex": 1 }
  ],
  "ignore": ["vendor/", "*.generated.gd"],
  "gitignore": true
}
```

* `trackFunctions`: your own track functions. A string is a function name
  whose first argument is the event name. When the name is a later argument,
  either add `@N` to the string (`"capture@1"`) or use an object with
  `argIndex` (`{ "name": "capture", "argIndex": 1 }`); both take 0 to 9 and
  mean the same thing. `--track-fn` values are added to these.
* `ignore`: extra patterns to skip, added to any `--ignore` flags.
* `gitignore`: set `false` to scan files the root `.gitignore` excludes.
  `--no-gitignore` also turns it off.

Invalid JSON or a wrong type on a known key stops the doctor with exit
code 2 and a message naming the problem. Unknown keys are ignored, with one
note on stderr naming them, so a config written for a later version still
works.

## The live check

`--live` proves the key in your project can deliver an event, end to end:

1. `GET /api/v1/settings` with the ingest key. A `401` means the key is
   wrong; tracking switched off for the game stops the check.
2. `POST /api/v1/session` with platform `doctor`.
3. `POST /api/v1/track/batch` with one `ravensight_doctor_ping` event whose
   data is `rs_kind: "none"`, a random `rs_doctor` value and the doctor
   version.
4. `GET /api/v1/doctor/ping/<rs_doctor value>` every 2 seconds, at most 10
   times, until the server confirms it stored the event.

The server keeps doctor sessions out of your analytics and your event quota,
and allows them only that one event name. The result is printed in a Live
check block and in the JSON as
`live: { ok, stage, trackingEnabled, accepted, found, acceptedAt, event, note }`.

| Outcome | Result |
| --- | --- |
| Read back | `stored`, with the time the server accepted it. |
| Accepted but not read back within 20 seconds | The warning `live_ping_unconfirmed`. Exit 0, or 1 with `--strict`. |
| Bad key, tracking switched off, a refused session or event, or no network | The error `live_check_failed`, so the status is `fail` (including in a `--report` sent afterwards), and exit 1. The note says which step failed. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | `pass`, `warn` or `inconclusive`, with no `--strict`. With `--strict`, only `pass`. |
| 1 | At least one error finding, a `--report` submission failure, a `--live` check that could not deliver its event (`live_check_failed`), or with `--strict` any status but `pass`. The local report is always printed first. |
| 2 | Usage error: unknown flag, missing value, a path that is not a directory, an invalid `--track-fn` (including an `@N` above 9), or a `ravensight.config.json` with invalid JSON or a wrong type. |

How each status maps to an exit code:

| Status | Without `--strict` | With `--strict` |
| --- | --- | --- |
| `pass` | 0 | 0 |
| `warn` | 0 | 1 |
| `inconclusive` (no literal names, or 25 percent or more unresolved) | 0 | 1 |
| `fail` | 1 | 1 |

Errors fail CI builds. Warnings and `inconclusive` do not, on purpose, so you
can adopt the doctor without breaking every pipeline on day one. Add
`--strict` when you want them to.

## CI setup

### GitHub Actions

The repository ships a composite action, so one step is enough:

```yaml
jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Reality-Software-Entertainment/ravensight-doctor@v0
```

With report submission:

```yaml
      - uses: Reality-Software-Entertainment/ravensight-doctor@v0
        with:
          path: .
          report: "true"
          api-key: ${{ secrets.RAVENSIGHT_INGEST_KEY }}
```

Inputs: `path` (default `.`), `report` (default `"false"`), `live`
(default `"false"`), `strict` (default `"false"`), `track-fn` (comma
separated function names, default empty), `include-tests` and
`include-docs` (default `"false"`) and `api-key` (used when `report`
or `live` is `"true"`; store it as a repository secret).

### GitLab CI

```yaml
ravensight-doctor:
  image: node:22
  stage: test
  script:
    - npx --yes ravensight-doctor .
```

See [docs/gitlab-ci.md](docs/gitlab-ci.md) for report submission and
artifact variants.

## The report API

`--report` sends the report to your Ravensight dashboard:

```
POST {api-url}/api/v1/doctor
X-API-Key: gt_live_...
Content-Type: application/json
```

```json
{
  "engine": "godot",
  "doctorVersion": "0.2.0",
  "summary": { "status": "warn", "errors": 0, "warnings": 1 },
  "findings": [
    {
      "id": "event_name_cardinality",
      "severity": "warning",
      "title": "Event name looks high cardinality",
      "detail": "...",
      "file": "scripts/player.gd",
      "line": 7
    }
  ]
}
```

`status` is `fail` when any error finding exists, `warn` when any warning
does, otherwise `pass`. The API knows these three only, so an
`inconclusive` report is sent as `warn`, and the inventory and live result
stay on your machine. At most 100 findings are included; past that they are
truncated and an info finding says so. A `201` means stored. Anything else
(bad key, bad payload, network trouble) is reported with a clear message and
the command exits 1, with the local report still printed.

The `gt_live_...` ingest key used here is the same publishable key your game
ships with. It cannot read analytics or touch your account.

## What it never does

* It never prints a secret it finds. Only a masked prefix (first 8
  characters) appears in findings.
* It never uploads your source code. `--report` sends only the findings
  shown above.
* It never phones home unless you pass `--report` or `--live`. `--live`
  sends one test event and nothing from your source.

## Development

```bash
npm test
```

The tests use the built in `node:test` runner over fixture projects in
`test/fixtures/`. Every credential in the fixtures is obviously fake and
planted on purpose.

## License

MIT. Copyright 2026 Reality Software Entertainment.
