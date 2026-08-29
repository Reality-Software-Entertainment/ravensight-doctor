// CLI entry logic for ravensight-doctor.
//
// Exit codes:
//   0  pass or warnings only
//   1  any error severity finding, or a --report submission failure
//   2  usage error

import fs from 'node:fs';
import path from 'node:path';
import { walkFiles, readText, detectEngine } from './scan.js';
import { runChecks } from './checks.js';
import { buildReport, formatPretty, submitReport } from './report.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const DEFAULT_API_URL = 'https://api.ravensight.io';

const USAGE = `Usage: ravensight-doctor [path] [options]

Scan a game project for Ravensight SDK integration problems.

Options:
  --json           Print the report as JSON to stdout
  --report         Also submit the report to the Ravensight API
  --key <key>      Ingest key (gt_live_...) for --report. Falls back to the
                   RAVENSIGHT_INGEST_KEY environment variable, then to the
                   first gt_live_ key found in the scanned project.
  --api-url <url>  API base URL (default ${DEFAULT_API_URL})
  --help, -h       Show this help
  --version, -v    Show the version

Exit codes: 0 pass or warnings, 1 errors or report failure, 2 usage error.
`;

/** Scan a project directory. Exported for tests. */
export function scanProject(root) {
  const files = walkFiles(root);
  const read = (rel) => readText(root, rel);
  const engine = detectEngine(root, files, read);
  const { findings, totals, liveKeys } = runChecks({ engine, files, read });
  return { engine, findings, totals, liveKeys, filesScanned: files.length };
}

/** Run the CLI. Returns the process exit code. */
export async function run(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let target = null;
  let json = false;
  let report = false;
  let key = null;
  let apiUrl = DEFAULT_API_URL;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--report') report = true;
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

  const scan = scanProject(root);
  const rep = buildReport(scan.engine, scan.findings, scan.totals, pkg.version);

  if (json) {
    stdout.write(JSON.stringify({ ...rep, filesScanned: scan.filesScanned }, null, 2) + '\n');
  } else {
    const useColor = Boolean(stdout.isTTY) && !env.NO_COLOR;
    stdout.write(formatPretty(rep, { path: root, filesScanned: scan.filesScanned, useColor }));
  }

  let failed = rep.summary.errors > 0;

  if (report) {
    const useKey = key || env.RAVENSIGHT_INGEST_KEY || scan.liveKeys[0] || null;
    if (!useKey) {
      stderr.write(
        'Report not submitted: no ingest key. Pass --key, set RAVENSIGHT_INGEST_KEY, ' +
          'or have a gt_live_ key in the project.\n',
      );
      failed = true;
    } else {
      const result = await submitReport(apiUrl, useKey, rep);
      stderr.write(result.message + '\n');
      if (!result.ok) failed = true;
    }
  }

  return failed ? 1 : 0;
}
