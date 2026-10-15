// CLI entry logic for ravensight-doctor.
//
// Exit codes:
//   0  pass, warn or inconclusive (without --strict), including a --live
//      ping that was accepted but not read back (live_ping_unconfirmed)
//   1  any error severity finding (including live_check_failed when --live
//      could not deliver its event), a --report submission failure, or with
//      --strict any status but pass
//   2  usage error, a broken ravensight.config.json or contract, an
//      unreadable --trace file, or a --bundle path with no Info.plist
//
// With --trace, the trace findings sit in their own block and do not
// change the status; --strict fails on any of them.

import fs from 'node:fs';
import path from 'node:path';
import { walkFiles, createReader, detectEngine } from './scan.js';
import { loadConfig, ConfigError, CONFIG_FILE, parseTrackFnFlags } from './config.js';
import {
  runChecks,
  capFindings,
  sortFindings,
  countBySeverity,
  liveUnconfirmedFinding,
  liveFailedFinding,
} from './checks.js';
import { loadContract, ContractError, contractFindings, propEvents, CONTRACT_FILE } from './contract.js';
import { runTrace, MAX_TRACE_LINES } from './trace.js';
import { runLive } from './live.js';
import { checkBundle, BundleError } from './bundle.js';
import { buildReport, formatPretty, submitReport, toSubmission, statusOf } from './report.js';

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
                   Analytics.logEvent or telemetry:track. A bare name matches
                   only unqualified calls; *.capture matches any receiver.
                   Add @N when the event name is argument N (capture@1).
                   Comma separated and repeatable.
  --include-tests  Also look for track calls in test paths (test, tests,
                   spec, fixtures, mocks, *.test.*, *.spec.*)
  --include-docs   Also look for track calls in docs (docs, doc, examples,
                   .md, .mdx, .rst, .txt). HTML pages are scanned inside
                   their <script> elements unless they sit under docs.
  --contract <file>
                   Event contract to check against (default
                   ravensight.contract.json in the scanned directory, if any)
  --trace <file>   Replay a JSONL file of events against the contract (at
                   most ${MAX_TRACE_LINES} lines). A runtime check of that file only.
  --strict         Exit 1 unless the status is pass, or on any trace finding
  --bundle <path>  A built .app or its Info.plist: confirm it carries an
                   ingest key (for keys injected at build time). The key is
                   never printed.
  --ignore <glob>  Skip files matching a .gitignore style pattern. Repeatable.
  --no-gitignore   Scan files the root .gitignore excludes
  --help, -h       Show this help
  --version, -v    Show the version

Configuration: ravensight.config.json in the scanned directory may set
trackFunctions (with optional paths and enriches per entry), ignoreCalls,
forwarders, ingestKey ({ "source": "build" } or "env"), kinds ("explicit"),
ignore and gitignore.
The contract's static check proves presence in source, not runtime values.

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
  // Throws ContractError for a broken contract or a missing --contract file.
  const contract = loadContract(root, opts.contract);
  const ignore = [...config.ignore, ...(opts.ignore || [])];
  const gitignore = opts.gitignore === false ? false : config.gitignore !== false;
  const files = walkFiles(root, { ignore, gitignore });
  const read = createReader(root);
  const engine = detectEngine(root, files, read);
  const trackFunctions = [...config.trackFunctions, ...(opts.trackFunctions || [])];
  const checked = runChecks({
    engine,
    files,
    read,
    trackFunctions,
    ignoreCalls: config.ignoreCalls,
    forwarders: config.forwarders,
    ingestKeySource: config.ingestKey.source,
    kinds: config.kinds,
    includeTests: Boolean(opts.includeTests),
    includeDocs: Boolean(opts.includeDocs),
    propEvents: contract ? propEvents(contract) : null,
  });
  const { liveKeys, testKeys, inventory } = checked;
  let { findings, allFindings, totals } = checked;
  let contractSummary = null;
  if (contract) {
    const cf = contractFindings(contract, inventory, checked.propSites);
    contractSummary = cf.summary;
    allFindings = sortFindings([...allFindings, ...cf.findings]);
  }
  // Throws BundleError for a --bundle path that cannot be read.
  const bundle = opts.bundle ? checkBundle(opts.bundle, opts.bundleOptions) : null;
  if (bundle) {
    // A key in the built bundle answers no_ingest_key.
    if (bundle.keyPresent) allFindings = allFindings.filter((f) => f.id !== 'no_ingest_key');
    allFindings = sortFindings([...allFindings, bundle.finding]);
  }
  if (contract || bundle) {
    findings = capFindings(allFindings);
    totals = countBySeverity(allFindings);
  }
  return {
    contract,
    contractSummary,
    bundle,
    ingestKeySource: config.ingestKey.source,
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
 * the project outside test paths, then the key in the --bundle plist. Keys
 * under test paths are never used; testOnly says they were the only ones
 * found.
 * Returns { key, source: 'flag' | 'env' | 'project' | 'bundle' | null, testOnly }.
 */
export function resolveKey({ flag, env, scan }) {
  if (flag) return { key: flag, source: 'flag', testOnly: false };
  if (env) return { key: env, source: 'env', testOnly: false };
  if (scan.liveKeys.length > 0) return { key: scan.liveKeys[0], source: 'project', testOnly: false };
  if (scan.bundle && scan.bundle.key) return { key: scan.bundle.key, source: 'bundle', testOnly: false };
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
  let contractFile = null;
  let traceFile = null;
  let bundlePath = null;

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
    } else if (a === '--bundle') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) {
        stderr.write('The --bundle option needs a path to a built .app or an Info.plist.\n\n' + USAGE);
        return 2;
      }
      bundlePath = path.resolve(v);
    } else if (a === '--contract' || a === '--trace') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) {
        stderr.write(`The ${a} option needs a file.\n\n` + USAGE);
        return 2;
      }
      if (a === '--contract') contractFile = v;
      else traceFile = v;
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
    scan = scanProject(root, {
      ignore,
      gitignore,
      trackFunctions,
      includeTests,
      includeDocs,
      contract: contractFile,
      bundle: bundlePath,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`${err.message}\nFix ${path.join(root, CONFIG_FILE)} or remove it.\n`);
      return 2;
    }
    if (err instanceof ContractError || err instanceof BundleError) {
      stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (scan.contract && scan.contract.unknownKeys.length > 0) {
    stderr.write(`Note: contract keys ignored: ${scan.contract.unknownKeys.join(', ')}.\n`);
  }

  let trace = null;
  if (traceFile) {
    if (!scan.contract) {
      stderr.write(
        `--trace needs a contract to check against: add ${CONTRACT_FILE} to the scanned directory or pass --contract <file>.\n`,
      );
      return 2;
    }
    try {
      trace = runTrace(scan.contract, path.resolve(traceFile), traceFile);
    } catch (err) {
      stderr.write(`Could not read the trace ${traceFile}: ${err.message}\n`);
      return 2;
    }
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
        game: null,
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
  const evidence = {
    static: statusOf(scan.findings, scan.totals, scan.inventory),
    notProvableStatically: scan.allFindings.filter((f) => f.id === 'contract_prop_unproven').length,
    trace: trace ? (trace.findings.length === 0 ? 'pass' : 'warn') : 'not run',
    live: liveResult ? (liveResult.ok ? 'stored' : liveResult.accepted ? 'accepted' : 'failed') : 'not run',
  };
  const rep = buildReport(scan.engine, findings, totals, pkg.version, {
    evidence,
    inventory: scan.inventory,
    live: liveResult,
    contract: scan.contractSummary,
    trace,
    bundle: scan.bundle ? { file: scan.bundle.file, keyPresent: scan.bundle.keyPresent, format: scan.bundle.format } : null,
  });

  if (json) {
    stdout.write(JSON.stringify({ ...rep, filesScanned: scan.filesScanned }, null, 2) + '\n');
  } else {
    const useColor = Boolean(stdout.isTTY) && !env.NO_COLOR;
    stdout.write(formatPretty(rep, { path: root, filesScanned: scan.filesScanned, useColor }));
  }

  let failed =
    rep.summary.status === 'fail' ||
    (strict && rep.summary.status !== 'pass') ||
    (strict && trace !== null && trace.findings.length > 0);

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
