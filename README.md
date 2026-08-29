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

## BETA notice

This tool is a beta. The checks are written and reviewed against the live
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
| `no_ingest_key` | warning | No `gt_live_` ingest key found anywhere. Fine if you inject it at runtime, fatal if you forgot it. |
| `event_name_cardinality` | warning | An event name embeds a multi digit number or string interpolation or concatenation. Identifiers belong in event data, not names. |
| `large_inline_payload` | warning | An object literal inside a track call spans more than 8KB of source. The server caps event data at 8KB serialized. |
| `no_track_calls` | info | The SDK is installed but nothing calls track yet. |
| `flush_on_exit_missing` | info | A hand rolled integration has track calls but no flush or exit handling, so the last batch is lost on quit. SDK engines handle this themselves and never get this finding. |

Engines detected: Godot, Unreal, Unity, iOS, Android, JavaScript, Odin, C++,
and `custom` for everything else. Detection is first match wins, and the whole
tree is scanned either way. `node_modules`, `.git`, `.import`, `.godot`,
`Library`, `Intermediate`, `DerivedData`, `build` and `dist` directories are
skipped, along with binary files and files over 2MB.

## Quickstart

From your project directory:

```bash
npx github:Reality-Software-Entertainment/ravensight-doctor
```

Or scan a specific path:

```bash
npx github:Reality-Software-Entertainment/ravensight-doctor path/to/game
```

Options:

| Flag | What it does |
| --- | --- |
| `--json` | Print the report as JSON to stdout. |
| `--report` | Also submit the report to the Ravensight API. |
| `--key gt_live_...` | Ingest key for `--report`. Falls back to the `RAVENSIGHT_INGEST_KEY` environment variable, then to the first `gt_live_` key found in the scanned project. |
| `--api-url <url>` | Override the API base URL. Only for self hosting. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Pass, or warnings and info only. |
| 1 | At least one error severity finding, or a `--report` submission failure. The local report is always printed first. |
| 2 | Usage error: unknown flag, missing value, or a path that is not a directory. |

Errors fail CI builds. Warnings do not, on purpose, so you can adopt the
doctor without breaking every pipeline on day one.

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

Inputs: `path` (default `.`), `report` (default `"false"`), `api-key`
(used when `report` is `"true"`; store it as a repository secret).

### GitLab CI

```yaml
ravensight-doctor:
  image: node:22
  stage: test
  script:
    - npx --yes github:Reality-Software-Entertainment/ravensight-doctor .
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
  "doctorVersion": "0.1.0",
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
does, otherwise `pass`. At most 100 findings are included; past that they are
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
* It never phones home unless you pass `--report`.

## Development

```bash
npm test
```

The tests use the built in `node:test` runner over fixture projects in
`test/fixtures/`. Every credential in the fixtures is obviously fake and
planted on purpose.

## License

MIT. Copyright 2026 Reality Software Entertainment.
