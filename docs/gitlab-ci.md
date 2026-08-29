# Ravensight Doctor on GitLab CI

Copy-paste job for `.gitlab-ci.yml`. It scans the repository and fails the
pipeline when the doctor finds an error severity problem (exit code 1).

```yaml
ravensight-doctor:
  image: node:22
  stage: test
  script:
    - npx --yes github:Reality-Software-Entertainment/ravensight-doctor .
```

That is the whole setup. The doctor has zero runtime dependencies, so the
`npx` install is quick.

## Submitting the report to Ravensight

To also store the report on your Ravensight dashboard, add a masked CI/CD
variable named `RAVENSIGHT_INGEST_KEY` (Settings, CI/CD, Variables) holding
your `gt_live_...` ingest key, then add `--report`:

```yaml
ravensight-doctor:
  image: node:22
  stage: test
  script:
    - npx --yes github:Reality-Software-Entertainment/ravensight-doctor . --report
  variables:
    GIT_DEPTH: "1"
```

The CLI reads `RAVENSIGHT_INGEST_KEY` from the environment automatically.
A failed submission exits 1 with the local report still printed, so a
network hiccup is visible in the job log instead of silently ignored.

## Scanning a subdirectory

If the game lives in a subdirectory of the repository, pass its path:

```yaml
    - npx --yes github:Reality-Software-Entertainment/ravensight-doctor game/
```

## Machine readable output

`--json` prints the full report as JSON to stdout, useful for piping into
your own tooling:

```yaml
    - npx --yes github:Reality-Software-Entertainment/ravensight-doctor . --json > doctor-report.json
  artifacts:
    when: always
    paths:
      - doctor-report.json
```

Note that `--json` still exits 1 on error findings, so keep the command
last in `script` or append `|| true` if you only want the artifact.
