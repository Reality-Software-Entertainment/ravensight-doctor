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
| `calls_outside_paths` | warning | A call matches a track function name, but every `trackFunctions` entry for that name has `paths` and none covers its file, so it was not checked. Lists up to 10 of them as file:line (form). Add a paths entry that covers those files, or an entry without paths. |
| `tracking_unresolved` | warning | Some track calls do not name their event with a string literal on the call line, so those names were not checked. Lists up to 20 of them as file:line. When they are 25 percent or more of all recognised calls the status is `inconclusive`. A concatenated or interpolated name (`"level_" + str(n)`) counts as unresolved here and also keeps its `event_name_cardinality` warning. |
| `no_ingest_key` | warning | No `gt_live_` ingest key found outside test paths. Fine if you inject it at runtime, fatal if you forgot it. |
| `event_name_cardinality` | warning | An event name embeds a multi digit number or string interpolation or concatenation. Identifiers belong in event data, not names. |
| `large_inline_payload` | warning | An object literal inside a track call spans more than 8KB of source. The server caps event data at 8KB serialized. |
| `live_check_failed` | error | `--live` could not deliver its test event: no usable key, a rejected key, tracking switched off, a refused session or event, or no network. The note says which step failed. |
| `live_ping_unconfirmed` | warning | `--live` sent its test event and the API accepted it, but it was not read back within 20 seconds. |
| `contract_event_missing` | warning | An event the contract names (in `events`, a `pairs_with` or `earned_once`) is not a literal event name in any track call. See [The event contract](#the-event-contract). |
| `contract_prop_missing` | warning | A literal props object at a call site lacks a key the contract requires for that event. Reported with file:line. |
| `contract_unmatched` | info | The contract names no event found in the scan at all, so nothing was compared. |
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
variable, or `names` for a ternary of two literals), the distinct event
names with their counts, the number of unresolved calls, the track
functions it looked for with their call counts (one row per
`trackFunctions` entry, with its `paths`),
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

Besides `function name(...)`, the definition can be any of these forms
(again matched on the last segment):

* Lua table constructor field: `track = function(n, d) get().track(n, d) end`
* Lua module field: `M.track = function(name, data) ... end`
* JavaScript object property: `track: function (name, data) { ... }`
* JavaScript method shorthand in an object literal or class:
  `track(name, data) { ... }`
* JavaScript arrow function: `const track = (name, data) => rs.track(name, data)`
  or `track = async name => { ... }`

An arrow function with a braced body ends at its closing brace; one with an
expression body ends at the end of its statement (a `;`, a `,` or closing
bracket outside its own brackets, or the end of the line).

A message or event handler forwards a field of its parameter instead,
as the bridge on a love.js page does. Inside the body of an anonymous
function passed as an argument or assigned to a property, a call whose
name argument is a field of one of that function's parameters is counted
as forwarded too:

* `window.addEventListener('message', (m) => { c.track(m.name, m.data) })`
* `bridge.onmessage = function (msg) { c.track(msg['event']) }`
* `on('x', ({ name }) => c.track(name))`, a name the parameter list
  destructures
* Lua: `bridge.on('message', function(m) c.track(m.name) end)` and a table
  field `track = function(m) c.track(m.name) end`

A local declared in the handler body from an expression that names one of
its parameters counts the same way, up to three levels of locals (a local
from a local from a local), whatever order they are declared in:
`Module.print = function (line) { const m = JSON.parse(line); c.track(m.name, m.data) }`,
`const { name } = JSON.parse(line)` and Lua
`function(line) local m = json.decode(line) c.track(m.name) end`. A local
from a literal or from something unrelated to the parameters does not;
a parameter name inside a string (`"line"`) or as an object key
(`{ line: 1 }`) is not a reference to it.

A named function declared on its own counts as a handler when its name
is assigned to a property anywhere in the file, before or after the
declaration (`function handle(text) { ... }` and later
`Module.print = handle;` or `window.__rsBridge = handle;`), with the same
rules for locals. A local declared without a value and assigned later,
even inside a `try` block (`let m; try { m = JSON.parse(text) } catch (e)
{ return }`), counts when every assignment to it in the body names a
parameter; one reassignment from a literal (`m = { name: "fallback" }`)
leaves it unresolved.

A plain parameter passed on (`items.forEach((n) => c.track(n))`), a name
that is not a parameter of the enclosing handler (`c.track(other.name)`),
a function assigned to a local variable and a named function whose name
is never assigned to a property all stay unresolved.

### Swift wrappers

A Swift game often wraps the SDK twice: `emit` sends an event and
`emitOnce` sends it only the first time a key is seen, forwarding to
`emit`:

```swift
enum Analytics {
    static var sent = Set<String>()

    static func emit(_ name: String, _ props: [String: Any] = [:]) {
        Ravensight.track(name, props)
    }

    static func emitOnce(key: String, _ name: String, props: [String: Any] = [:]) {
        guard !sent.contains(key) else { return }
        sent.insert(key)
        emit(name, props)
    }
}

Analytics.emit("run_started", ["run_id": runId])
Analytics.emitOnce(key: "intro", "progress_unlocked", props: ["content_id": "intro"])
```

Name both wrappers. The event name is argument 1 of `emitOnce`, counting
every argument, labelled or not:

```bash
npx --yes ravensight-doctor --track-fn '*.emit,*.emitOnce@1'
```

or in `ravensight.config.json`:

```json
{ "trackFunctions": ["*.emit", "*.emitOnce@1"] }
```

The `*.` form counts calls through the type (`Analytics.emit(`); add the
bare `emit` and `emitOnce@1` as well if you call them without the type
from inside it. A labelled argument such as `name: "ending_seen"` is read
as its value, in Swift and C#.

With only `emit` named, the `emit(name, props)` inside `emitOnce` is an
unresolved call. When an unresolved Swift call passes a parameter of the
function around it, the `tracking_unresolved` finding names that function,
the argument position and the `--track-fn` value to add (for example
`--track-fn '*.emitOnce@1'`), and the call's inventory row carries
`suggestTrackFn`.

### Which calls count as track calls

* Member calls where the name right before `.track(` is exactly `rs`,
  `ravensight` or `Ravensight`, with any chain before it: `rs.track(`,
  `this.rs.track(`, `window.rs.track(` and `Game.Ravensight.track(` all
  count, while `analytics.track(` and `myrs.track(` do not.
* `Ravensight.Track(` (Unity), `->Track(` (Unreal) and `track(client, ...)`
  (Odin, where the event name is the second argument).
* Your own functions, named with `--track-fn` or `trackFunctions` (see
  [Configuration](#configuration)):
  * A bare name such as `capture` matches only an unqualified call,
    `capture(`. A call with a receiver, meaning a `.`, `?.` or `::` right
    before the name (whitespace allowed) or a `->` directly before it
    (`$this->capture(`), is a different function and does not count:
    `analytics.capture(` and `client?.capture(` are left alone. A spaced
    arrow is a Kotlin or Java lambda or `when` branch, so
    `x -> capture("a")` still counts. When a bare name was only ever called
    on a receiver, its `track_fn_unused` note suggests the `*.` form. In Lua a `:` counts as a receiver too (`telemetry:capture(`);
    elsewhere a lone `:` is a ternary arm or an object key, so
    `won ? capture("a") : null` still counts.
  * A name with a leading `*.`, such as `*.capture`, matches the call on any
    receiver (`analytics.capture(`, `client?.capture(`,
    `this.client.capture(`, Lua's `telemetry:capture(`) and never a bare
    `capture(`. Name both when you want both.
  * A dotted name such as `Analytics.logEvent` must match from its first
    segment, so `Game.Analytics.logEvent(` counts and
    `MyAnalytics.logEvent(` does not.
  * A Lua method name such as `telemetry:track` (one `:` before the last
    segment) matches `telemetry:track(` and `telemetry.track(` both.

  Function definitions are not counted as calls, including Lua's
  `function x.track(`, `function x:track(`, `local function track(` and
  `function track(`.
* When two forms match the same call (for example `*.track` and the built
  in `rs.track` both match `rs.track(`), it is one call, credited to the
  most specific form, the one with the longest name.
* A call whose event name is a ternary of two string literals,
  `capture(won ? 'playoff_round_cleared' : 'playoff_eliminated')`, counts
  both names. The call is listed once, with `names: [...]` in place of
  `name`. A nested ternary, or one with an arm that is not a string literal,
  stays unresolved, and so does `cond && 'name'`.

Track calls inside the SDK's own files are ignored, so its doc comments do
not trip findings.

### Comments

Calls are matched after comments are blanked out, so a commented out call is
never counted. Line numbers are unchanged.

| Files | Comments removed |
| --- | --- |
| `.js .mjs .cjs .ts .mts .cts .tsx .jsx .cs .swift .kt .java .odin .c .cc .cpp .h .hpp` | `//` to the end of the line, and `/* ... */` |
| `.vue .svelte` | `<!-- -->` and `<style>` blocks; `//` and `/* ... */` inside `<script>` blocks |
| `.gd .py .rb .sh` | `#` to the end of the line |
| `.lua` | `--` to the end of the line, and `--[[ ... ]]` (also `--[==[ ... ]==]`) |
| anything else | nothing |

In JavaScript and TypeScript (including the scripts in HTML, Vue and Svelte
files) regex literals are followed on their line, so a quote or a `/*`
inside `/'/g`, `/\/*$/` or `/[/*]/` is read as part of the regex, and a
`'` right after a letter or digit, as in the JSX text `Don't`, does not
start a string. A `/*` outside a string or regex always starts a block
comment, wherever it sits on the line. A Vue or Svelte component keeps its
markup, because a template handler such as `@click="capture('x')"` is a real
call; its `<script>` blocks are stripped as JavaScript when they are
JavaScript or TypeScript (by `type` or `lang`) and left out otherwise.

Known limit: quoted strings are only followed within one line, so a comment
marker inside a string that spans lines (a template literal, a Python triple
quoted string, a Lua long string) can be mistaken for a comment. Key checks
read the file as written, so a key inside a comment is still reported.

Upgrading from 0.3.1: no differences expected except where a comment-stripping fix applies.

### Scan scope

Key checks (ingest keys, MCP tokens and other secrets) read every file the
walk below finds. Track calls are looked for in a narrower set, so tests and
documentation do not count as calls:

* Test paths are left out: files under `test`, `tests`, `spec`, `specs`,
  `__tests__`, `fixtures`, `__fixtures__` or `__mocks__` at any depth, and
  `*.test.*` and `*.spec.*` files. `--include-tests` brings them back.
* Docs are left out: `.md`, `.mdx`, `.rst` and `.txt` files, and files
  under `docs`, `doc`, `examples` or `example` at any depth.
  `--include-docs` brings them back.
* HTML pages (`.html`, `.htm`) are scanned, but only the code inside their
  JavaScript `<script>` elements: those with no `type`, `type="module"`, or a
  `javascript` or `ecmascript` type. JSON, `importmap`, template and other
  script types are skipped. Page text, markup and `<!-- -->` comments are ignored,
  and comments inside the scripts are stripped as JavaScript. A web build's
  `index.html` that calls `rs.track('game_started')` in a page script is
  counted. An HTML page under a docs directory is left out like any other
  docs file, and the left out line names it, for example
  `2 docs files (HTML: docs/index.html)`; the JSON inventory has
  `htmlLeftOutOfCallScan: { count, files }`, with up to 20 paths in `files`.
* A vendored copy of the SDK, any directory named `ravensight` (for example
  `lib/ravensight/`, `vendor/ravensight/`, `addons/ravensight/`) and any SDK
  file named `ravensight*`, is always left out.

Directory names match in any case, so Unity's `Assets/Tests` is a test path.
The header shows both counts and what was left out, for example:

```
  Files:   448 scanned for calls, 6432 scanned for keys
           5984 files left out of the call scan: 5120 test files, 860 docs files, 4 vendored SDK files; use --include-tests or --include-docs to scan them
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
  Ignore patterns keep basename semantics for a name with only a trailing
  slash (`foo/` skips a `foo` directory at any depth), while `paths` on a
  track function anchors any pattern with a slash, `foo/` included.

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
| `--strict` | Exit 1 on any status but `pass`, including `warn` and `inconclusive`, and on any trace finding. |
| `--contract <file>` | The event contract to check against. Defaults to `ravensight.contract.json` in the scanned directory when it exists. See [The event contract](#the-event-contract). |
| `--trace <file.jsonl>` | Replay a file of events against the contract, at most 50,000 lines. See [Trace replay](#trace-replay). |
| `--track-fn <name>` | Also count calls to your own track function. Comma separated and repeatable: `--track-fn capture,Analytics.logEvent`. A bare name matches only unqualified calls; `*.capture` matches `capture` on any receiver (quote it in a shell: `--track-fn '*.capture'`). A Lua method works as `telemetry:track`. Add `@N` when the event name is argument N (0 to 9): `--track-fn capture@1` for `capture(userId, "level_start")`. |
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
    "Analytics.logEvent",
    "telemetry:track",
    "*.send@1",
    { "name": "track_event", "argIndex": 1 }
  ],
  "ignoreCalls": ["vendor.capture"],
  "ignore": ["vendor/", "*.generated.gd"],
  "gitignore": true
}
```

* `trackFunctions`: your own track functions. A string is a function name
  whose first argument is the event name. When the name is a later argument,
  either add `@N` to the string (`"capture@1"`) or use an object with
  `argIndex` (`{ "name": "capture", "argIndex": 1 }`); both take 0 to 9 and
  mean the same thing. `--track-fn` values are added to these.
* `paths` on an object entry: glob patterns, relative to the scanned
  directory, for the files the entry applies to (see below).
* `ignoreCalls`: calls to leave out of the inventory entirely, written like a
  `trackFunctions` name: an exact dotted receiver (`"vendor.capture"`) or
  `"*.capture"` for any receiver. See "Calls that are not yours to check".
* `ignore`: extra patterns to skip, added to any `--ignore` flags.
* `gitignore`: set `false` to scan files the root `.gitignore` excludes.
  `--no-gitignore` also turns it off.

Invalid JSON or a wrong type on a known key stops the doctor with exit
code 2 and a message naming the problem. Unknown keys are ignored, with one
note on stderr naming them, so a config written for a later version still
works.

### Calls that are not yours to check

A wrapper often sends the same event name to Ravensight and to another
analytics client, and a `*.capture` entry in `trackFunctions` then matches
both calls. Inside a function named in `trackFunctions` the doctor follows
the wrapper's name parameter on its own, whatever the receiver, and a call
outside the entry's `paths` that forwards it is forwarded, not
`calls_outside_paths`. These shapes resolve with nothing to configure:

* **The parameter itself, or a local derived from it.**
  `function logEvent(name, props) { vendor.capture(name, props) }`
* **An object literal at the entry's argument position** whose `event`,
  `name` or `event_name` property (or the shorthand) is the parameter or a
  derived local:
  `function logEvent(name, props) { vendor.capture({ event: name, properties: props }) }`
  and `const event = name.trim(); vendor.capture({ event })`. The literal may
  span lines. A string as the value is not
  forwarded, and neither is an object without one of those three keys.
* **An object literal with a string name.** `vendor.capture({ event:
  'level_start' })` is a literal name: it is read as `level_start` and
  counted in the inventory and the event names like any literal first
  argument (it is not forwarded, and not unresolved).
* **A field of a message handler's parameter.**
  `window.addEventListener('message', (m) => rs.track(m.name, m.data))`
* **A queue the wrapper fills and a loop flushes.** A member of a loop
  variable counts when the same file pushes that key into the iterated
  array from inside a wrapper, with the name parameter as the value:
  `function logEvent(name, props) { queue.push({ event: name, props }) }`
  and, anywhere in the file,
  `for (const call of queue) client.capture(call.event, call.props)`
  (also `call['event']`, `queue.forEach((call) => ...)` and
  `for (const { event } of queue)`). One level only: JavaScript and
  TypeScript files, the array matched by its last name (`this.queue` and
  `queue` are one), and the push must be inside a track function.

These need `ignoreCalls`, because the doctor cannot follow them:

* **A call outside any wrapper.** `vendor.capture(name, props)` in a
  function that is not named in `trackFunctions`.
* **A queue filled somewhere else.** A push from a helper that is not a
  track function, a queue built by spread, concat or assignment, or one
  emptied with `shift()` or `pop()`:
  `const call = queue.shift(); vendor.capture(call.event)`.
* **A wrapper with a parameter list over several lines**, or a name built
  at the call (`vendor.capture('ui_' + id)`).

**`ignoreCalls`.** A call matching an entry (`"vendor.capture"` matches that
receiver only; `"*.capture"` matches any receiver) is left out of the
inventory, counted as `ignoredCalls` in the JSON and printed as `Ignored
calls: N (ignoreCalls)`, and never produces an unresolved, outside-paths or
contract finding. Use it for a call that sends to another service and never
to Ravensight. An ignored call is not checked at all, so keep the entries
exact.

An unrelated call that matches a track function and is neither forwarded
nor ignored stays unresolved.

### One function name, different argument positions by path

A project with a server and a browser client can have two functions with
the same name whose event name sits in different places, for example
`capture(userId, 'match_finished')` on the server and
`capture('shop_opened', props)` in the dashboard. Give each entry the
`paths` it applies to, and one scan reads both:

```json
{
  "trackFunctions": [
    { "name": "capture", "argIndex": 1, "paths": ["server/**"] },
    { "name": "capture", "argIndex": 0, "paths": ["dashboard/**"] }
  ]
}
```

* `paths` takes the same glob patterns as `ignore`, without `!`, with
  forward slashes only (a backslash is a config error naming the entry).
  A leading `./` is dropped. A pattern that matches a directory covers
  every file under it.
* A pattern with a slash anywhere in it (`src/**`, `/src/**`, `src/`,
  `server/api`) is anchored to the scanned directory: `src/**` covers
  `src/a.js` and never `dashboard/src/lib/telemetry.js`, and `/src/**`
  means the same as `src/**`.
* A bare name with no slash (`src`, `*.mjs`) matches a file or directory
  name at any depth, so `src` covers both `src/a.js` and
  `dashboard/src/lib/telemetry.js`. Write `src/**` when you mean only the
  top level `src` directory.
* An entry without `paths` applies everywhere. When several entries share a
  name, the entry whose matching pattern is the most specific wins for a
  file (the most characters that are not `*`, `?` or `/`; the earlier entry
  on a tie), and the entry without `paths` covers every other file.
* Two entries without `paths` for the same name stop the doctor with exit
  code 2 and a message naming both, because it could not tell which
  argument holds the event name. The same goes for two `--track-fn` values.
* `paths` limit where the name is a track function. A call in a file that
  no entry covers (every entry has `paths` and none matches) is not a track
  call: it is left out of the track calls, the event names and the
  unresolved count. It is counted in `callsOutsidePaths`, printed as
  `Outside paths: N` in the pretty inventory, and listed by the
  `calls_outside_paths` warning (so `--strict` fails). Add a paths entry
  that covers those files, or an entry without `paths` for the name.
* The inventory's `trackFunctions` lists each entry on its own, with its
  `paths` and its own call count, and the pretty report shows them as
  `capture (server/**) 2, capture (dashboard/**) 1`.
* A `--track-fn` value never has paths. When the config names the same
  function with paths only, the flag adds the entry for every other file;
  when the config already has an entry without paths, the config wins.

## The event contract

An optional `ravensight.contract.json` in the scanned directory (or the
file `--contract` names) says which events your game must send and what
they must carry. This one is for a narrative game: run checkpoints, choices
and their outcomes paired by `decision_id`, and unlocks that are earned
once:

```json
{
  "events": {
    "run_checkpoint": { "required": ["run_id", "chapter", "foreground_seconds"], "join": "run_id" },
    "choice_made": { "required": ["decision_id", "depth"], "nonzero": ["depth"] },
    "choice_outcome": { "required": ["decision_id", "outcome"], "pairs_with": "choice_made", "join": "decision_id" },
    "progress_unlocked": { "required": ["content_id"] }
  },
  "cumulative": ["foreground_seconds"],
  "attempt_ids": ["decision_id"],
  "earned_once": { "event": "progress_unlocked", "key": "content_id" }
}
```

* `events`: per event, `required` props, `nonzero` props (required and
  never `0`), and `pairs_with` with `join`: an opening event that carries
  the same value of the `join` prop must appear somewhere in the trace,
  before or after it.
* `cumulative`: props that never go down within the same join id. A plain
  name follows each event's own `join` (the session when the event has
  none); `{ "prop": "foreground_seconds", "join": "run_id" }` names the
  join for every event.
* `attempt_ids`: props every event in their scope must carry. A plain name
  applies to the events that name it in `required` or `join`, and to their
  `pairs_with` openers; `{ "prop": "decision_id", "events": ["..."] }`
  names the scope.
* `earned_once`: `{ "event", "key" }`, or a list of them. The same key may
  be emitted once per device (`device_id` in a platform export, `deviceId`
  from the SDK), or once per session when the row has no device id. A
  repeat must carry `loaded: true`, the marker for unlocks replayed from a
  save. This is intended: an unlock replayed with `loaded: true` sets the
  baseline, and the same key emitted again without the marker after it is
  flagged, because that is a new unlock event for something already
  earned.

Invalid JSON, a wrong type, a `pairs_with` without `join` or an
`attempt_ids` name no event uses stops the doctor with exit code 2. Unknown
keys are ignored with a note on stderr.

### What the static scan proves

Without `--trace` the contract is checked against your source only:

* Every event the contract names must appear as a literal event name in a
  track call, or it is the warning `contract_event_missing`. When none of
  them appears at all, that is one `contract_unmatched` info instead.
* A literal props object at a call site (`{ run_id: id }`, Lua
  `{ run_id = id }`, GDScript `{"run_id": id}`, Swift `["run_id": id]`)
  that lacks a required key is the warning `contract_prop_missing`, with
  the file and line. A props argument the doctor cannot read for certain
  (a variable, a spread, a computed key) is not checked.

This proves presence in source, not runtime values. Static scanning cannot
prove that pairs line up, that a duration never goes down, that an attempt
id is filled in, that a depth is not zero, or that an unlock is not
repeated after loading a save. Those are checked only by trace replay,
over a file you provide. The pretty report prints a Contract block saying
so, and the JSON has `contract: { file, events, matched, missing, propSitesChecked }`.

For the contract above and this source, the doctor reports
`contract_event_missing` for `progress_unlocked` and
`contract_prop_missing` for `depth` at `src/story.js:6`:

```js
export function checkpoint(run, chapter) {
  rs.track('run_checkpoint', { run_id: run.id, chapter, foreground_seconds: run.seconds });
}
export function choose(decision) {
  rs.track('choice_made', { decision_id: decision.id });
  rs.track('choice_outcome', { decision_id: decision.id, outcome: decision.result });
}
```

## Trace replay

`--trace <file.jsonl>` replays a file of events against the contract. It
is a runtime check over the file you provided, not a proof of production
behaviour. Each line is one event, either the shape an exported session
and `get_integration_status` give:

```json
{ "event_name": "choice_made", "ts": "2026-10-14T10:01:00Z", "session_id": "s1", "props": { "decision_id": "d1", "depth": 2 } }
```

or the SDK's batch shape:

```json
{ "event": "choice_made", "data": { "decision_id": "d1", "depth": 2 }, "timestamp": "2026-10-14T10:01:00Z", "deviceId": "dev-1" }
```

The SDK sends the session id as a request header, not in the body, so a
batch shape event has no session unless the line (or its container)
carries `session_id`; add it when you capture several sessions into one
file. A line holding an `events` array (a captured request body or a page
of an export) is expanded into its events, and a `session_id` or
`device_id` on the container applies to each of them.

At most 50,000 lines are read; the rest of the file is ignored and the
report says so. The file is read line by line and each event keeps only
the props the contract names, so memory follows the number of events, not
the file size. A line over 64 KB is skipped without being read. Blank
lines are ignored; any other line that gives no event (not JSON, not an
object, no `event_name` or `event`, over 64 KB) is skipped, and the first
10 skipped lines are listed with their line numbers and the reason. When
no event at all could be checked (an empty file, or nothing readable) the
replay reports the warning `trace_nothing_checked`.

Events are compared in file order. When you combine files from several
devices or sessions, sort the result by `ts` first, so a cumulative value
is compared in the order it was sent. `--trace` needs a contract; without
one it stops with exit code 2.

| Finding | What it means |
| --- | --- |
| `trace_cumulative_decreased` | A `cumulative` prop went down within the same join id. |
| `trace_orphan_outcome` | A `pairs_with` event arrived for a join id whose opening event appears nowhere in the trace. |
| `trace_missing_attempt_id` | An event in an `attempt_ids` scope arrived without the id. |
| `trace_missing_depth` | A required prop was absent or empty, or `0` where the contract marks it `nonzero`. |
| `trace_repeated_earned` | The same `earned_once` key was emitted twice on one device (or in one session, when the row has no device id) without `loaded: true`. |
| `trace_nothing_checked` | The file gave no event to check: it is empty, or no line is a readable event. |

Each is a warning that lists its first 10 offending rows (file line, event,
session and what was wrong) and counts the rest. The findings are printed
in a block titled "Trace replay (runtime check over the file you provided,
not a proof of production behaviour)" and in the JSON as
`trace: { file, lines, checked, skipped, skippedLines, truncated, maxLines, findings }`,
where `skippedLines` lists the first 10 skipped lines as `{ line, reason }`.
They do not change the status and are never sent by `--report`;
`--strict` exits 1 on any of them.

For the narrative contract, this trace:

```
{"event_name":"run_checkpoint","session_id":"s1","props":{"run_id":"r1","chapter":1,"foreground_seconds":120}}
{"event_name":"choice_made","session_id":"s1","props":{"decision_id":"d1","depth":2}}
{"event_name":"choice_outcome","session_id":"s1","props":{"decision_id":"d1","outcome":"spared"}}
{"event_name":"choice_outcome","session_id":"s1","props":{"decision_id":"d9","outcome":"fled"}}
{"event_name":"choice_made","session_id":"s1","props":{"depth":0}}
{"event_name":"progress_unlocked","session_id":"s1","props":{"content_id":"ending_a"}}
{"event":"run_checkpoint","session_id":"s2","data":{"run_id":"r1","chapter":2,"foreground_seconds":45}}
{"event":"progress_unlocked","session_id":"s2","data":{"content_id":"ending_a","loaded":true}}
{"event":"progress_unlocked","session_id":"s2","data":{"content_id":"ending_a"}}
```

gives one row for each check: `foreground_seconds` went from 120 to 45
within `run_id=r1` (line 7, a timer reset on load), `decision_id=d9` never
had a `choice_made` (line 4), the `choice_made` on line 5 has no
`decision_id` and a `depth` of 0, and `content_id=ending_a` was emitted
again on line 9 after the loaded baseline on line 8.

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

Steps 1 to 3 are each tried once more, after 3 seconds, when the first answer
is a 5xx or no answer at all (an API restart or a network blip). A 4xx is
never retried. When a step was retried the note says so (for example
`GET /api/v1/settings retried once after 502`) and the JSON lists the steps in
`live.retried`; only a second failure of the same step fails the check. Step 4
is already a poll, so a single bad answer there does not stop it.

The server keeps doctor sessions out of your analytics and your event quota,
and allows them only that one event name. The result is printed in a Live
check block and in the JSON as
`live: { ok, stage, trackingEnabled, accepted, found, acceptedAt, event, note }`,
plus `retried` when a step was tried twice.

| Outcome | Result |
| --- | --- |
| Read back | `stored`, with the time the server accepted it. |
| Accepted but not read back within 20 seconds | The warning `live_ping_unconfirmed`. Exit 0, or 1 with `--strict`. |
| Bad key, tracking switched off, a refused session or event, or no network (after the one retry for a 5xx or network error) | The error `live_check_failed`, so the status is `fail` (including in a `--report` sent afterwards), and exit 1. The note says which step failed. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | `pass`, `warn` or `inconclusive`, with no `--strict`. With `--strict`, only `pass`. |
| 1 | At least one error finding, a `--report` submission failure, a `--live` check that could not deliver its event (`live_check_failed`), or with `--strict` any status but `pass`. The local report is always printed first. |
| 2 | Usage error: unknown flag, missing value, a path that is not a directory, an invalid `--track-fn` (including an `@N` above 9), a `ravensight.config.json` with invalid JSON, a wrong type, invalid `paths`, or two entries without `paths` for the same function, a broken contract or a missing `--contract` file, or a `--trace` file that cannot be read or has no contract to check against. |

How each status maps to an exit code:

| Status | Without `--strict` | With `--strict` |
| --- | --- | --- |
| `pass` | 0 | 0 |
| `warn` | 0 | 1 |
| `inconclusive` (no literal names, or 25 percent or more unresolved) | 0 | 1 |
| `fail` | 1 | 1 |

Trace findings do not change the status, so they never set the exit code
on their own; with `--strict` any trace finding exits 1.

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
`include-docs` (default `"false"`), `contract` (a contract file,
default empty, which uses `ravensight.contract.json` in `path` when it
exists), `trace` (a JSONL file of events to replay, default empty) and
`api-key` (used when `report` or `live` is `"true"`; store it as a
repository secret). Paths are relative to the workspace.

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
`inconclusive` report is sent as `warn`, and the inventory, live result,
contract block and trace replay stay on your machine (the static
`contract_*` findings are sent like any other finding). At most 100 findings are included; past that they are
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
* It never sends a `--trace` file anywhere; the replay runs on your machine.
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
