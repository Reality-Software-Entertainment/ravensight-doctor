# Changelog

## 0.5.0

Upgrading: a `--bundle` build that carries a `gt_live_` key now fails
(exit 1, with or without `--strict`). Ship a public key (`gt_pub_`) in
builds players receive: https://ravensight.io/docs/#public-builds. A
`--bundle` directory without an `Info.plist` is now scanned as a build
instead of stopping with exit code 2.

### Added

* `live_key_in_bundle` (error): a `gt_live_` key inside a build players
  receive. One finding per file or archive member, naming it and the key's
  first four characters only, with a pointer to the public builds docs.
* `test_key_in_bundle` (warning): a `gt_test_` key inside such a build.
* `--bundle` reads the whole build: a web build directory (minified
  JavaScript included), a `.love`, `.zip`, `.apk` or `.ipa` member by
  member (stored or deflated, nested archives, a fused LOVE executable),
  and executables, `.pck` and `.wasm` files, where a key stored as an
  ASCII string is found even when another string follows it directly.
* JSON `bundle` gains `filesScanned` and `keys: { live, public, test }`.

### Changed

* `bundle_key_present` and `bundle_key_missing` count a `gt_pub_` key as
  an ingest key. A `gt_pub_` key alone passes.
* The `--live` and `--report` fallback takes the first `gt_live_` key in
  the build and never a `gt_pub_` key, which the doctor's ping and report
  refuse.

## 0.4.2

Upgrading: nothing is required. One change can move a status:
`contract_prop_missing` at a call through your own track function is now
the info `contract_prop_unproven` unless the entry declares `enriches`.
The new `name_without_kind` is an info unless you set `"kinds":
"explicit"`. Calls that were unresolved may now be forwarded or named.

### Added

* `enriches` on a `trackFunctions` entry: the keys the wrapper adds to
  every payload. A required contract key listed there is never reported
  missing at that wrapper's call sites. Without the declaration a wrapper
  call site that lacks a key is `contract_prop_unproven` (info): not
  provable statically; the runtime trace is the evidence. The trace replay
  is unchanged and stays strict.
* `ingestKey: { "source": "build" }` or `{ "source": "env" }` in the config
  turns `no_ingest_key` into an info ("Key is injected at build time; check
  the built bundle", or read from the environment at startup).
* `--bundle <path>`: a built `.app` or an `Info.plist` (XML, or binary
  through `plutil` when available and its raw string bytes otherwise) is
  checked for an ingest key of the right shape: `bundle_key_present`
  (info, replaces `no_ingest_key`) or `bundle_key_missing` (warning). The
  key is never printed; it is the last fallback for `--live` and
  `--report`. JSON `bundle: { file, keyPresent, format }`.
* Forwarding closures: a Swift `{ name, data in Ravensight.track(name,
  data) }` or JavaScript `(name, data) => rs.track(name, data)` assigned to
  a property or passed as a sink is forwarded. Iteration callbacks stay
  unresolved, both on the collection (`names.forEach(...)`) and through a
  helper that takes it first (`_.each(names, ...)`, `Array.from(names,
  ...)`). This changes one 0.4.1 result: a closure in an object literal,
  `{ other: (name) => Ravensight.track(name) }`, was unresolved outside a
  named wrapper's body and is now forwarded as a sink.
* `forwarders` in the config: functions or closure properties
  (`TelemetrySink.send`) whose body forwards in a way the heuristic cannot
  see; `forwarder_unmatched` (info) when one is not found.
* Event names from object constants: `capture(EVENTS.registered)` resolves
  to the literal from `const EVENTS = { registered: 'registered' }` in the
  same file, or an exported constant the file imports by name.
* `name_without_kind`: a literal event name that the platform's
  level funnel reads by substring (`start`, `begin`, `enter`, `complet`,
  `finish`, `win`, `clear`, `died`, `destroyed`, `killed`, copied from the
  platform's event kinds) at a call whose literal props have no `rs_kind`,
  or that sends none. Skipped when the wrapper's `enriches` lists
  `rs_kind`. Detection by name is a documented default, so it is an info;
  config `"kinds": "explicit"` (every level event carries `rs_kind`) makes
  it a warning.
* Three evidence lines after the findings, `Static: <verdict> (<N> findings
  not provable statically)`, `Runtime trace: <pass|warn|not run>` and
  `Live delivery: <stored|accepted|failed|not run>`, and JSON
  `evidence: { static, trace, live, notProvableStatically }`. The
  top-level status stays the static verdict.
* `--live` prints `key belongs to <name> (<slug>, <environment>)` from
  `GET /api/v1/settings`, and the JSON has `live.game` (`null` from a
  server that does not say).

### Changed

* An object literal forwards the wrapper's name parameter wherever that
  parameter sits in the wrapper's parameter list
  (`capture(distinctId, event)` calling `vendor.capture({ distinctId,
  event, properties })`, where `capture@1` has no argument 1). When the call
  has an argument at the entry's position, only that argument counts, so
  `Ravensight.track(currentScreen, { event, ...props })` stays unresolved. A queue drain also forwards an object built from
  the loop member (`{ event: call.event }`, or a destructured `{ event }`).
* A TypeScript method signature in an interface or type literal and an
  abstract method are declarations, never calls.
* README: native Xcode projects, keys injected at build time or read from
  the environment, forwarding closures, event names that read as a level
  event, the evidence lines, and which environment a key hits.
* The test script runs every suite (two had been left out).

### Security

* Every server provided string the doctor prints (the game name, slug and
  environment, server error messages in `--live` and `--report` output, the
  accepted at time) goes through one sanitiser that strips ESC sequences,
  C0 and C1 control characters, bidi and zero width characters and bounds
  the length to 80, so a crafted value cannot spoof the report's labels.
  The JSON output keeps the raw game values.

## 0.4.1

Upgrading: nothing to change. Calls that were unresolved inside a configured
wrapper may now count as forwarded.

### Changed

* A matched call whose argument at the entry's position is an object
  literal with an `event`, `name` or `event_name` property (or the
  shorthand) holding the wrapper's name parameter, or a local derived from
  it, is forwarded (`vendor.capture({ event: name, properties })`). The
  literal may span lines.
* An object literal whose `event`, `name` or `event_name` property is a
  string (`vendor.capture({ event: 'level_start' })`) is read as that
  literal name and counted in the inventory and event names.
* A member of a loop variable (`call.event`, `call['event']`, a destructured
  `event`) is forwarded when the loop iterates an array that a wrapper in the
  same file pushes `{ event: name }` into. One level, JavaScript and
  TypeScript only; anything else needs `ignoreCalls`.
* README: "Calls that are not yours to check" lists the shapes that resolve
  on their own and the ones that need `ignoreCalls`.

## 0.4.0

Upgrading: nothing to change. A `ravensight.contract.json` in the scanned
directory is now read when it exists; a broken one stops the doctor with
exit code 2. A Swift or C# labelled argument (`name: "ending_seen"`) is now
read as its value, so calls that were unresolved may now report names.

### Added

* Config `ignoreCalls`: calls left out of the inventory entirely (exact
  dotted receivers such as `vendor.capture`, or `*.capture`, matched like
  `trackFunctions`). They are counted as `ignoredCalls` in the JSON
  inventory, printed as `Ignored calls: N (ignoreCalls)`, and never produce
  an unresolved, outside-paths or contract finding.
* A matched call inside a track function's body that passes the function's
  parameter on is forwarded even when its file is outside the entry's
  `paths`, instead of `calls_outside_paths`.
* Event contract: `ravensight.contract.json`, or any file with
  `--contract <file>`, with per event `required`, `nonzero`, `pairs_with`
  and `join`, plus `cumulative`, `attempt_ids` and `earned_once`. The
  static check is a check of presence in source, not of runtime values:
  `contract_event_missing` (warning) for a contract event no track call
  names, `contract_prop_missing` (warning, with file:line) for a literal
  props object missing a required key, and `contract_unmatched` (info)
  when the contract names nothing in the scan. The pretty report prints a
  Contract block and the JSON a `contract` object.
* Trace replay: `--trace <file.jsonl>` checks the contract's runtime rules
  over a file of events (the exported session shape or the SDK batch
  shape), at most 50,000 lines with a note when the rest is ignored:
  `trace_cumulative_decreased`, `trace_orphan_outcome`,
  `trace_missing_attempt_id`, `trace_missing_depth` and
  `trace_repeated_earned` (a repeat on one device, or in one session
  without a device id, that lacks `loaded: true`), each with its first 10
  offending rows, and `trace_nothing_checked` when no event could be
  read. The file is read line by line with a compact record per event (the
  props the contract names only), a line over 64 KB is skipped unread, the
  first 10 skipped lines are listed with their reasons, and a line holding
  an `events` array is expanded into its events. The block is titled "Trace replay (runtime
  check over the file you provided, not a proof of production
  behaviour)", the JSON gets `trace: { lines, checked, findings, ... }`,
  the findings do not change the status or go out with `--report`, and
  `--strict` fails on any of them.
* Swift forwarding hint: when an unresolved Swift call passes a parameter
  of the function around it (`emit(name, props)` inside `emitOnce`), the
  `tracking_unresolved` finding names that function, the argument
  position counting labelled arguments, and the `--track-fn` value to add,
  such as `'*.emitOnce@1'`. The inventory row carries `suggestTrackFn`.
  The README has a Swift section with the `emit` and `emitOnce@1`
  wrappers.
* GitHub Action inputs `contract` and `trace`.

### Fixed

* Handler forwarders now cover two more bridge forms. A named function
  declared on its own whose name is assigned to a property anywhere in
  the file (`function handle(text) { ... }` and `Module.print = handle;`
  or `window.__rsBridge = handle;`) counts as a handler. A local declared
  without a value and assigned later, even in a `try` block (`let m; try
  { m = JSON.parse(text) } catch (e) { return }`), counts as derived when
  every assignment to it names a parameter; a reassignment from a literal
  leaves it unresolved. All four combinations of declared or inline
  handler with `let m; try` or `const m = parseLine(text)` now read as
  forwarded.

## 0.3.3

Upgrading: when every `trackFunctions` entry for a name has `paths`, a
call in a file none of them covers is no longer reported as an unresolved
track call. It is reported by the new `calls_outside_paths` warning
instead (so `--strict` still fails), counted in `callsOutsidePaths` and
printed as `Outside paths: N` in the pretty inventory. Add a paths entry
that covers those files, or an entry without `paths`.

### Fixed

* `paths` now limit matching. A `*.capture` entry with `paths:
  ["src/**"]` (or `"/src/**"`) used to leave `client.capture(...)` in
  `dashboard/src/lib/telemetry.js` in the report as an unresolved track
  call, which could make the status inconclusive. The pattern resolution
  was already anchored; the call itself was still counted as a track call.
  It is now reported by `calls_outside_paths` instead.
* A pattern with any slash, a trailing one included (`src/`), is anchored
  to the scanned directory, and a leading `./` is dropped wherever the
  pattern is compiled. A bare name (`src`) still matches a directory of
  that name at any depth; the README now shows both cases.

### Added

* `calls_outside_paths` warning: up to 10 `file:line (form)` locations of
  calls outside every entry's `paths`.
* Handler forwarders: inside an anonymous function passed as an argument
  or assigned to a property, a call whose name argument is a field of the
  function's parameter (`m.name`, `msg.event`, `payload['name']`,
  `e.data.name`) or a name its parameter list destructures is counted as
  forwarded, not unresolved. JavaScript arrows and function expressions,
  and Lua `function(m) ... end` handlers and table fields. A plain
  parameter or an unrelated name stays unresolved. A local declared in the
  handler from an expression naming a parameter (`const m =
  JSON.parse(line)`, `const { name } = JSON.parse(line)`, Lua `local m =
  json.decode(line)`) counts as the parameter, up to three levels of
  locals; a local from a literal, an unrelated call, a string that spells
  the parameter's name or an object key does not.

## 0.3.2

Upgrading: a bare `--track-fn capture` (or `"capture"` in
`trackFunctions`) no longer matches `analytics.capture(` or
`client.capture(`. Add `*.capture` if those calls are yours. A config that
names the same function twice without `paths` (for example `"capture"` and
`"capture@1"`) now stops with exit code 2 instead of silently keeping the
first.

### Added

* `paths` on a `trackFunctions` entry: glob patterns, in the same subset as
  `ignore`, for the files the entry applies to. Several entries can share a
  name with different `argIndex` values, so a server `capture(userId, name)`
  and a browser `capture(name, props)` are read in one scan. The most
  specific matching pattern wins, the entry without `paths` covers every
  other file, and two entries without `paths` for one name are a config
  error naming both. A leading `./` in a pattern is dropped and a
  backslash is a config error naming the entry. The inventory lists each entry with its `paths` and
  its own call count; a call in a file no entry covers is unresolved with
  `outsidePaths: true` and counted in `callsOutsidePaths`.
* `*.capture`: a track function spec that matches the call on any receiver
  (`analytics.capture(`, `client?.capture(`, Lua's `telemetry:capture(`).
* A ternary of two string literals,
  `capture(won ? 'playoff_round_cleared' : 'playoff_eliminated')`, resolves
  to both names, listed once on the call as `names`. Nested ternaries and
  non literal arms stay unresolved.

### Changed

* A bare track function name matches only an unqualified call: no `.`,
  `?.` or `::` right before it, no `->` directly before it (a spaced
  Kotlin or Java arrow, `x -> capture(`, still counts), and no `:` in Lua.
  `track_fn_unused` suggests `*.name` when a bare name was only ever called
  on a receiver. Dotted names
  (`Analytics.logEvent`) match their chain as before.

### Fixed

* Commented out calls no longer count in these cases:
  * `.mts` and `.cts` files, which had no comment stripping at all.
  * Vue and Svelte components (`.vue`, `.svelte`), which had none either.
    Their markup is kept, since template handlers are real calls, while
    `<!-- -->` comments and `<style>` blocks are blanked and `<script>`
    blocks are stripped as JavaScript or TypeScript.
  * A `//` comment after a regex literal holding a quote, such as
    `s.replace(/'/g, '') // ...`: the quote opened a string that hid the
    comment. Regex literals are now followed on their line.
  * A `/* ... */` spanning lines that opened after a word, a number or a
    string (`return /*`, `x = 1 /*`, `'a' /*`), which was read as code.
  * JSX text with an apostrophe before a comment on the same line
    (`Don't {/* ... */}`).

## 0.3.1

### Fixed

* HTML pages are scanned for track calls again, inside their `<script>`
  elements only. Page text, markup and `<!-- -->` comments are ignored, and
  the script bodies have their JavaScript comments stripped, so a web build's
  `index.html` that calls `rs.track('game_started')` is counted. `.md`,
  `.mdx`, `.rst` and `.txt` stay out of the call scan. An HTML page under a
  docs directory is still left out, and the left out line now names it
  (`htmlLeftOutOfCallScan` in the JSON inventory).
* A wrapper assigned to a name, field or property is now recognised for
  forwarded calls: a Lua table constructor field
  (`track = function(n, d) ... end`), a Lua module field
  (`M.track = function(name, data) ... end`), a JavaScript object property
  (`track: function (name, data) { ... }`) and a JavaScript arrow function
  (`const track = (name, data) => rs.track(name, data)`), alongside the
  method shorthand `track(name, data) { ... }`. An arrow function with an
  expression body ends at the end of its statement.
* `--live` tries `GET /settings`, `POST /session` and the ping event once
  more, after 3 seconds, on a 5xx or a network error, never on a 4xx. The
  note says "retried once" and `live.retried` names the step; only a second
  failure fails the run.

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
