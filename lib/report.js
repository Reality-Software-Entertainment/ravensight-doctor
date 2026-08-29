// Report building, pretty printing and submission for ravensight-doctor.

/**
 * Build the report object exactly as the Ravensight report API expects it:
 * POST {api-url}/api/v1/doctor
 * { engine, doctorVersion, summary: { status, errors, warnings }, findings }
 */
export function buildReport(engine, findings, totals, doctorVersion) {
  const status = totals.errors > 0 ? 'fail' : totals.warnings > 0 ? 'warn' : 'pass';
  return {
    engine,
    doctorVersion,
    summary: { status, errors: totals.errors, warnings: totals.warnings },
    findings,
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

  if (report.findings.length === 0) {
    lines.push(`  ${c('green', 'No findings. Your integration looks healthy.')}`);
  }
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

  const { errors, warnings } = report.summary;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const statusColor =
    report.summary.status === 'fail' ? 'red' : report.summary.status === 'warn' ? 'yellow' : 'green';
  lines.push(`  Summary: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`);
  lines.push(`  Status:  ${c(statusColor, report.summary.status)}`);
  lines.push('');
  return lines.join('\n');
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
