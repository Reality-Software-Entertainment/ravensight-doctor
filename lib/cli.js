// CLI entry logic for ravensight-doctor.
//
// Exit codes:
//   0  pass, warn or inconclusive (without --strict), including a --live
//      ping that was accepted but not read back (live_ping_unconfirmed)
//   1  any error severity finding (including live_check_failed when --live
//      could not deliver its event), a --report submission failure, or with
//      --strict any status but pass
//   2  usage error or a broken ravensight.config.json

import fs from 'node:fs';
import path from 'node:path';
import { walkFiles, createReader, detectEngine } from './scan.js';
import { loadConfig, ConfigError, CONFIG_FILE, parseTrackFnFlags } from './config.js';
import { runChecks, capFindings, countBySeverity, liveUnconfirmedFinding, liveFailedFinding } from './checks.js';
import { runLive } from './live.js';
import { buildReport, formatPretty, submitReport, toSubmission } from './report.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const DEFAULT_API_URL = 'https://api.ravensight.io';

const USAGE = `Usage: ravensight-doctor [path] [options]

Scan a game project for Ravensight SDK integration problems.

Options:
  --json           Print the report as JSON to stdout
  --report         Also submit the report to the Ravensight API
  --live           Send one test event with the ingest key and confirm the
                   API stored it (about 20 s at most)
  --key <key>      Ingest key (gt_live_...) for --report and --live. Falls
                   back to RAVENSIGHT_INGEST_KEY, then to the first gt_live_
                   key in the project outside test paths.
  --api-url <url>  API base URL (default ${DEFAULT_API_URL})
  --track-fn <fn>  Also count calls to your own track function, e.g. capture,
                   Analytics.logEvent or telemetry:track. Add @N when the
                   event name is argument N (capture@1). Comma separated and
                   repeatable.
  --include-tests  Also look for track calls in test paths (test, tests,
                   spec, fixtures, mocks, *.test.*, *.spec.*)
  --include-docs   Also look for track calls in docs (docs, doc, examples,
                   .md, .mdx, .rst, .txt, .html)
  --strict         Exit 1 unless the status is pass
  --ignore <glob>  Skip files matching a .gitignore style pattern. Repeatable.
  --no-gitignore   Scan files the root .gitignore excludes
  --help, -h       Show this help
  --version, -v    Show the version

Configuration: ravensight.config.json in the scanned directory may set
trackFunctions, ignore and gitignore.

Key hygiene always scans every file, tests and docs included.

Exit codes: 0 pass, warn or inconclusive; 1 errors, a failed --report or
--live, or anything but pass with --strict; 2 usage or config error.
`;

/**
 * Scan a project directory. Exported for tests.
 * opts = { ignore: string[], gitignore: boolean, trackFunctions: spec[] }
 * add to (never replace) what ravensight.config.json in root says;
 * gitignore: false from the caller wins over the config file.
 * opts.includeTests and opts.includeDocs widen the track call scope.
 * Throws ConfigError for a broken config file.
 */
export function scanProject(root, opts = {}) {
  const config = loadConfig(root);
  const ignore = [...config.ignore, ...(opts.ignore || [])];
  const gitignore = opts.gitignore === false ? false : config.gitignore !== false;
  const files = walkFiles(root, { ignore, gitignore });
  const read = createReader(root);
  const engine = detectEngine(root, files, read);
  const trackFunctions = [...config.trackFunctions, ...(opts.trackFunctions || [])];
  const { findings, allFindings, totals, liveKeys, testKeys, inventory } = runChecks({
    engine,
    files,
    read,
    trackFunctions,
    includeTests: Boolean(opts.includeTests),
    includeDocs: Boolean(opts.includeDocs),
  });
  return {
    engine,
    findings,
    allFindings,
    totals,
    liveKeys,
    testKeys,
    inventory,
    filesScanned: files.length,
    readStats: read.stats,
    unknownConfigKeys: config.unknownKeys,
  };
}

/**
 * Pick the ingest key for --report and --live: the --key flag, then the
 * RAVENSIGHT_INGEST_KEY environment variable, then the first key found in
 * the project outside test paths. Keys under test paths are never used;
 * testOnly says they were the only ones found.
 * Returns { key, source: 'flag' | 'env' | 'project' | null, testOnly }.
 */
export function resolveKey({ flag, env, scan }) {
  if (flag) return { key: flag, source: 'flag', testOnly: false };
  if (env) return { key: env, source: 'env', testOnly: false };
  if (scan.liveKeys.length > 0) return { key: scan.liveKeys[0], source: 'project', testOnly: false };
  return { key: null, source: null, testOnly: scan.testKeys.length > 0 };
}

function missingKeyMessage(resolved) {
  return (
    'no ingest key. Pass --key or set RAVENSIGHT_INGEST_KEY' +
    (resolved.testOnly
      ? '. The only gt_live_ keys found are under test paths (test, tests, fixtures, ' +
        '__tests__, __fixtures__, __mocks__, *.test.*, *.spec.*), and those are never used.'
      : ', or have a gt_live_ key in the project.')
  );
}

/** Run the CLI. Returns the process exit code. */
export async function run(
  argv,
  { stdout = process.stdout, stderr = process.stderr, env = process.env, live: liveOptions = {} } = {},
) {
  let target = null;
  let json = false;
  let report = false;
  let live = false;
  let key = null;
  let apiUrl = DEFAULT_API_URL;
  const ignore = [];
  let gitignore = true;
  let strict = false;
  let includeTests = false;
  let includeDocs = false;
  const trackFnValues = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--report') report = true;
    else if (a === '--live') live = true;
    else if (a === '--key') {
      key = argv[++i];
      if (!key || key.startsWith('-')) {
        stderr.write('The --key option needs a value.\n\n' + USAGE);
        return 2;
      }
    } else if (a === '--api-url') {
      apiUrl = argv[++i];
      if (!apiUrl || apiUrl.startsWith('-')) {
        stderr.write('The --api-url option needs a value.\n\n' + USAGE);
        return 2;
      }
    } else if (a === '--ignore') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) {
        stderr.write('The --ignore option needs a pattern.\n\n' + USAGE);
        return 2;
      }
      ignore.push(v);
    } else if (a === '--track-fn') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) {
        stderr.write('The --track-fn option needs a function name.\n\n' + USAGE);
        return 2;
      }
      trackFnValues.push(v);
    } else if (a === '--strict') {
      strict = true;
    } else if (a === '--include-tests') {
      includeTests = true;
    } else if (a === '--include-docs') {
      includeDocs = true;
    } else if (a === '--no-gitignore') {
      gitignore = false;
    } else if (a === '--help' || a === '-h') {
      stdout.write(USAGE);
      return 0;
    } else if (a === '--version' || a === '-v') {
      stdout.write(pkg.version + '\n');
      return 0;
    } else if (a.startsWith('-')) {
      stderr.write(`Unknown option: ${a}\n\n` + USAGE);
      return 2;
    } else if (target === null) {
      target = a;
    } else {
      stderr.write('Only one path can be scanned at a time.\n\n' + USAGE);
      return 2;
    }
  }

  const root = path.resolve(target ?? '.');
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch {
    // handled below
  }
  if (!stat || !stat.isDirectory()) {
    stderr.write(`Not a directory: ${root}\n`);
    return 2;
  }

  let trackFunctions;
  try {
    trackFunctions = parseTrackFnFlags(trackFnValues);
  } catch (err) {
    stderr.write(`--track-fn: ${err.message}\n`);
    return 2;
  }

  let scan;
  try {
    scan = scanProject(root, { ignore, gitignore, trackFunctions, includeTests, includeDocs });
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`${err.message}\nFix ${path.join(root, CONFIG_FILE)} or remove it.\n`);
      return 2;
    }
    throw err;
  }
  if (scan.unknownConfigKeys.length > 0) {
    stderr.write(`Note: ${CONFIG_FILE} keys ignored: ${scan.unknownConfigKeys.join(', ')}.\n`);
  }

  // Scan, then the live check, then print, then submit.
  const resolved = resolveKey({ flag: key, env: env.RAVENSIGHT_INGEST_KEY, scan });
  let findings = scan.findings;
  let totals = scan.totals;
  let liveResult = null;
  if (live) {
    if (!resolved.key) {
      liveResult = {
        ok: false,
        stage: 'key',
        trackingEnabled: null,
        accepted: false,
        found: false,
        acceptedAt: null,
        event: 'ravensight_doctor_ping',
        note: 'Live check not run: ' + missingKeyMessage(resolved),
      };
    } else {
      liveResult = await runLive({ apiUrl, key: resolved.key, doctorVersion: pkg.version, ...liveOptions });
    }
    if (!liveResult.ok) {
      // A ping that never got through is an error, so a report sent after it
      // cannot say pass; one accepted but not read back is only a warning.
      const extra = liveResult.accepted
        ? liveUnconfirmedFinding(liveResult.note)
        : liveFailedFinding(liveResult.stage, liveResult.note);
      const all = [...scan.allFindings, extra];
      findings = capFindings(all);
      totals = countBySeverity(all);
    }
  }
  const rep = buildReport(scan.engine, findings, totals, pkg.version, { inventory: scan.inventory, live: liveResult });

  if (json) {
    stdout.write(JSON.stringify({ ...rep, filesScanned: scan.filesScanned }, null, 2) + '\n');
  } else {
    const useColor = Boolean(stdout.isTTY) && !env.NO_COLOR;
    stdout.write(formatPretty(rep, { path: root, filesScanned: scan.filesScanned, useColor }));
  }

  let failed = rep.summary.status === 'fail' || (strict && rep.summary.status !== 'pass');

  if (report) {
    const useKey = resolved.key;
    if (!useKey) {
      stderr.write('Report not submitted: ' + missingKeyMessage(resolved) + '\n');
      failed = true;
    } else {
      const result = await submitReport(apiUrl, useKey, toSubmission(rep));
      stderr.write(result.message + '\n');
      if (!result.ok) failed = true;
    }
  }

  return failed ? 1 : 0;
}
