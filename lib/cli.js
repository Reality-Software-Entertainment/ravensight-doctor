// CLI entry logic for ravensight-doctor.
//
// Exit codes:
//   0  pass or warnings only
//   1  any error severity finding, or a --report submission failure
//   2  usage error

import fs from 'node:fs';
import path from 'node:path';
import { walkFiles, createReader, detectEngine } from './scan.js';
import { loadConfig, ConfigError, CONFIG_FILE, parseTrackFnFlags } from './config.js';
import { runChecks, liveUnconfirmedFinding } from './checks.js';
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
  --track-fn <fn>  Also count calls to your own track function, e.g. capture
                   or Analytics.logEvent. Comma separated and repeatable.
  --strict         Exit 1 unless the status is pass
  --ignore <glob>  Skip files matching a .gitignore style pattern. Repeatable.
  --no-gitignore   Scan files the root .gitignore excludes
  --help, -h       Show this help
  --version, -v    Show the version

Configuration: ravensight.config.json in the scanned directory may set
trackFunctions, ignore and gitignore.

Exit codes: 0 pass, warn or inconclusive; 1 errors, a failed --report or
--live, or anything but pass with --strict; 2 usage or config error.
`;

/**
 * Scan a project directory. Exported for tests.
 * opts = { ignore: string[], gitignore: boolean, trackFunctions: spec[] }
 * add to (never replace) what ravensight.config.json in root says;
 * gitignore: false from the caller wins over the config file.
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
  const { findings, totals, liveKeys, testKeys, inventory } = runChecks({ engine, files, read, trackFunctions });
  return { engine, findings, totals, liveKeys, testKeys, inventory, filesScanned: files.length, readStats: read.stats };
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

const MAX_FINDINGS = 100;

/** Add a finding after the errors, keeping the 100 finding cap. */
function withFinding(findings, extra) {
  const out = findings.slice();
  let at = out.findIndex((f) => f.severity !== 'error');
  if (at === -1) at = out.length;
  out.splice(at, 0, extra);
  if (out.length > MAX_FINDINGS) {
    // Drop the last ordinary finding, keeping the truncation marker last.
    let drop = out.length - 2;
    if (out[drop] === extra) drop--;
    out.splice(drop, 1);
  }
  return out;
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
    scan = scanProject(root, { ignore, gitignore, trackFunctions });
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`${err.message}\nFix ${path.join(root, CONFIG_FILE)} or remove it.\n`);
      return 2;
    }
    throw err;
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
      if (liveResult.accepted && !liveResult.ok) {
        findings = withFinding(findings, liveUnconfirmedFinding(liveResult.note));
        totals = { errors: totals.errors, warnings: totals.warnings + 1 };
      }
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
  // A live check that could not deliver its event is a failure; one that was
  // accepted but not read back is only the live_ping_unconfirmed warning.
  if (liveResult && !liveResult.ok && !liveResult.accepted) failed = true;

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
