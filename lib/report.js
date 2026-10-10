// Report building, pretty printing and submission for ravensight-doctor.

/**
 * The local status of a scan, in precedence order fail > inconclusive >
 * warn > pass. inconclusive means the doctor could not verify how events
 * are tracked (a tracking_unverified finding), which is the doctor's blind
 * spot rather than a defect in the project.
 */
export function statusOf(findings, totals) {
  if (totals.errors > 0) return 'fail';
  if (findings.some((f) => f.id === 'tracking_unverified')) return 'inconclusive';
  if (totals.warnings > 0) return 'warn';
  return 'pass';
}

/**
 * Build the local report:
 * { engine, doctorVersion, summary: { status, errors, warnings }, findings,
 *   inventory?, live? }
 * Use toSubmission() for what the report API accepts.
 */
export function buildReport(engine, findings, totals, doctorVersion, extras = {}) {
  const rep = {
    engine,
    doctorVersion,
    summary: { status: statusOf(findings, totals), errors: totals.errors, warnings: totals.warnings },
    findings,
  };
  if (extras.inventory) rep.inventory = extras.inventory;
  if (extras.live) rep.live = extras.live;
  return rep;
}

/**
 * The report exactly as POST {api-url}/api/v1/doctor accepts it. The API
 * knows pass, warn and fail only, so inconclusive is sent as warn, and the
 * inventory and live result stay local.
 */
export function toSubmission(report) {
  const { status, errors, warnings } = report.summary;
  return {
    engine: report.engine,
    doctorVersion: report.doctorVersion,
    summary: { status: status === 'inconclusive' ? 'warn' : status, errors, warnings },
    findings: report.findings,
  };
}

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
};

/** Human readable report for the terminal. */
export function formatPretty(report, { path, filesScanned, useColor = false } = {}) {
  const c = (code, s) => (useColor ? COLORS[code] + s + COLORS.reset : s);
  const lines = [];
  lines.push(c('bold', `ravensight doctor v${report.doctorVersion}`));
  lines.push('');
  if (path) lines.push(`  Path:    ${path}`);
  lines.push(`  Engine:  ${report.engine}`);
  if (filesScanned != null) lines.push(`  Files:   ${filesScanned} scanned`);
  lines.push('');

  for (const f of report.findings) {
    const tag =
      f.severity === 'error'
        ? c('red', 'ERROR')
        : f.severity === 'warning'
          ? c('yellow', 'WARN ')
          : c('cyan', 'INFO ');
    const where = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '';
    lines.push(`  ${tag}  ${c('bold', f.id)}  ${f.title}`);
    if (where) lines.push(`         ${c('dim', where)}`);
    lines.push(`         ${f.detail}`);
    lines.push('');
  }

  if (report.inventory) lines.push(...formatInventory(report.inventory, c), '');
  if (report.live) lines.push(...formatLive(report.live, c), '');

  const { errors, warnings, status } = report.summary;
  if (status === 'pass') {
    lines.push(`  ${c('green', report.findings.length === 0 ? 'No findings. Your integration looks healthy.' : 'No errors or warnings. Your integration looks healthy.')}`);
    lines.push('');
  } else if (status === 'inconclusive') {
    lines.push(
      `  ${c('yellow', 'Inconclusive: the doctor could not verify how this project tracks events. See tracking_unverified above.')}`,
    );
    lines.push('');
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const statusColor = status === 'fail' ? 'red' : status === 'pass' ? 'green' : 'yellow';
  lines.push(`  Summary: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`);
  lines.push(`  Status:  ${c(statusColor, status)}`);
  lines.push('');
  return lines.join('\n');
}

const MAX_LISTED_NAMES = 10;

function formatInventory(inv, c) {
  const out = [`  ${c('bold', 'Inventory')}`];
  const named = inv.trackCalls.length - inv.unresolvedCalls;
  out.push(
    `    Track calls:  ${inv.trackCalls.length} (${named} with a literal name, ${inv.unresolvedCalls} unresolved)`,
  );
  if (inv.eventNames.length === 0) {
    out.push('    Event names:  none found');
  } else {
    const shown = inv.eventNames.slice(0, MAX_LISTED_NAMES).map((e) => `${e.name} (${e.count})`);
    const more = inv.eventNames.length - shown.length;
    out.push(`    Event names:  ${inv.eventNames.length} distinct: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`);
  }
  const used = inv.trackFunctions.filter((f) => f.calls > 0 || f.source !== 'builtin');
  out.push(
    `    Recognised:   ${used.length === 0 ? 'no track call forms matched' : used.map((f) => `${f.name} ${f.calls}`).join(', ')}`,
  );
  const { live, test } = inv.ingestKeys;
  out.push(`    Ingest keys:  ${live} live${test ? `, ${test} only under test paths` : ''}`);
  return out;
}

function formatLive(live, c) {
  const out = [`  ${c('bold', 'Live check')}`];
  const tag = live.ok ? c('green', 'stored') : live.accepted ? c('yellow', 'unconfirmed') : c('red', 'failed');
  out.push(`    Result:       ${tag}`);
  if (live.acceptedAt) out.push(`    Accepted at:  ${live.acceptedAt}`);
  if (live.note) out.push(`    ${live.note}`);
  return out;
}

/**
 * POST the report to {apiUrl}/api/v1/doctor with X-API-Key auth.
 * Never throws; returns { ok, message }.
 */
export async function submitReport(apiUrl, key, report) {
  const url = apiUrl.replace(/\/+$/, '') + '/api/v1/doctor';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-Key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(report),
    });
  } catch (err) {
    return {
      ok: false,
      message:
        `Report not submitted: could not reach ${url} ` +
        `(${err && err.cause && err.cause.code ? err.cause.code : err.message}). ` +
        'Check your network and the --api-url value.',
    };
  }
  if (res.status === 201) {
    return { ok: true, message: 'Report submitted to Ravensight.' };
  }
  if (res.status === 401) {
    return {
      ok: false,
      message:
        'Report not submitted: the API rejected the ingest key (401). ' +
        'Check the --key value or the RAVENSIGHT_INGEST_KEY environment variable.',
    };
  }
  if (res.status === 400) {
    let detail = '';
    try {
      const body = await res.json();
      if (body && (body.error || body.message)) detail = ` Server said: ${body.error || body.message}`;
    } catch {
      // ignore unparseable body
    }
    return { ok: false, message: `Report not submitted: the API rejected the report (400).${detail}` };
  }
  if (res.status === 404) {
    return {
      ok: false,
      message:
        'Report not submitted: the doctor endpoint was not found (404). ' +
        'The server at this URL may not support doctor reports. Check --api-url.',
    };
  }
  return { ok: false, message: `Report not submitted: unexpected response ${res.status}.` };
}
