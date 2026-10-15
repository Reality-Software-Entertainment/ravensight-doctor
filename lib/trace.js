// Trace replay: the contract's runtime rules checked over a JSONL file of
// events the caller provides (--trace). This is a check of that file, not
// a proof of production behaviour.
//
// Each line is one event, in either shape:
//   { "event_name": "...", "ts": "...", "session_id": "...", "device_id": "...", "props": { ... } }
//   { "event": "...", "data": { ... }, "timestamp": "..." }   (the SDK batch shape)
// or a line holding an "events" array of them (a captured request body or
// an export page), which is expanded into its events. The SDK sends the
// session id as a request header, not in the body, so a batch shape event
// has a session only when the line or its container carries session_id.
// props may also be a JSON string. Blank lines are skipped; any other line
// that gives no event is skipped and listed (the first 10).
//
// Memory stays bounded by the number of events, not the bytes read: the
// file is read in chunks and parsed line by line, a line over 64 KB is
// skipped unread, and each event keeps only a compact record (line,
// event name, session, device and the props the contract names). At most
// MAX_TRACE_LINES lines are read and the rest is ignored with a note.

import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { finding } from './checks.js';

export const MAX_TRACE_LINES = 50000;
export const MAX_LINE_CHARS = 64 * 1024;
// How far past the line limit the reader looks for more text before it
// stops and says the rest was ignored.
const TAIL_PROBE_CHARS = 1024 * 1024;
const MAX_ROWS = 10;
const MAX_SKIPPED_LISTED = 10;
const NO_SESSION = '(no session)';

/**
 * Read file line by line, calling onLine(text, lineNumber) for each of
 * the first maxLines lines, with text null for a line over MAX_LINE_CHARS
 * (its text is never held). Returns { lines, truncated } where truncated
 * says more text came after the last line read. Reading stops at the
 * limit; at most 1 MB past it is probed for non blank text.
 */
export function readTraceLines(file, onLine, maxLines = MAX_TRACE_LINES, maxLineChars = MAX_LINE_CHARS) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let lines = 0;
  let cur = '';
  let oversize = false;
  let truncated = false;
  let probing = false;
  let probed = 0;
  const emit = () => {
    lines++;
    onLine(oversize ? null : cur, lines);
    cur = '';
    oversize = false;
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      const chunk = n === 0 ? decoder.end() : decoder.write(buf.subarray(0, n));
      if (probing) {
        if (/\S/.test(chunk)) {
          truncated = true;
          break;
        }
        probed += chunk.length;
        if (n === 0) break;
        if (probed > TAIL_PROBE_CHARS) {
          truncated = true; // a long blank tail: say the rest was ignored rather than read it all
          break;
        }
        continue;
      }
      let from = 0;
      while (from <= chunk.length) {
        const nl = chunk.indexOf('\n', from);
        const end = nl === -1 ? chunk.length : nl;
        if (!oversize) {
          if (cur.length + (end - from) > maxLineChars) {
            oversize = true;
            cur = '';
          } else cur += chunk.slice(from, end);
        }
        if (nl === -1) break;
        emit();
        from = nl + 1;
        if (lines >= maxLines) {
          const rest = chunk.slice(from);
          if (/\S/.test(rest)) truncated = true;
          else {
            probing = true;
            probed = rest.length;
          }
          break;
        }
      }
      if (truncated) break;
      if (n === 0) {
        if (!probing && (cur !== '' || oversize) && lines < maxLines) emit();
        break;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { lines, truncated };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const idOf = (...vals) => {
  const v = vals.find((x) => typeof x === 'string' || typeof x === 'number');
  return v != null && v !== '' ? String(v) : null;
};

/**
 * One parsed object as an event { event, session, device, ts, props } or
 * null. inherit carries a container's session and device for the events
 * of an "events" array.
 */
function toEvent(o, inherit = {}) {
  if (!isObj(o)) return null;
  const event = [o.event_name, o.event, o.name].find((v) => typeof v === 'string' && v !== '');
  if (!event) return null;
  let props = o.props !== undefined ? o.props : o.data !== undefined ? o.data : o.properties;
  if (typeof props === 'string') {
    try {
      props = JSON.parse(props);
    } catch {
      props = {};
    }
  }
  if (!isObj(props)) props = {};
  const session = idOf(o.session_id, o.sessionId, props.session_id, inherit.session) || NO_SESSION;
  const device = idOf(o.device_id, o.deviceId, props.device_id, props.deviceId, inherit.device);
  return { event, session, device, ts: o.ts ?? o.timestamp ?? null, props };
}

/**
 * One trace line as { events: [...] } or { error } when it gives no event.
 * A line holding an "events" array is expanded into its events.
 */
export function parseTraceLine(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return { error: 'not JSON' };
  }
  if (isObj(o) && Array.isArray(o.events)) {
    const inherit = { session: idOf(o.session_id, o.sessionId), device: idOf(o.device_id, o.deviceId) };
    const events = o.events.map((e) => toEvent(e, inherit)).filter(Boolean);
    return events.length ? { events } : { error: 'an events array with no event in it' };
  }
  if (!isObj(o)) return { error: 'not a JSON object' };
  const e = toEvent(o);
  return e ? { events: [e] } : { error: 'no event name (event_name or event)' };
}

/** Every prop name the contract reads, so a trace record keeps only those. */
export function contractProps(contract) {
  const names = new Set(['loaded']);
  for (const e of contract.events.values()) {
    for (const p of [...e.required, ...e.nonzero]) names.add(p);
    if (e.join) names.add(e.join);
  }
  for (const c of contract.cumulative) {
    names.add(c.prop);
    if (c.join) names.add(c.join);
  }
  for (const a of contract.attemptIds) names.add(a.prop);
  for (const r of contract.earnedOnce) names.add(r.key);
  return names;
}

/** The compact record kept per event: the contract's props only. */
function compact(e, line, keep) {
  const props = {};
  for (const k of keep) if (Object.prototype.hasOwnProperty.call(e.props, k)) props[k] = e.props[k];
  const rec = { line, event: e.event, session: e.session, props };
  if (e.device) rec.device = e.device;
  return rec;
}

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const isZero = (v) => (typeof v === 'number' && v === 0) || (typeof v === 'string' && v.trim() !== '' && Number(v) === 0);
const isLoaded = (v) => v === true || v === 'true';
function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Offending rows: counts every push, keeps the first MAX_ROWS. */
function collector() {
  const rows = [];
  rows.count = 0;
  const push = rows.push.bind(rows);
  rows.push = (r) => {
    rows.count++;
    if (rows.length < MAX_ROWS) push(r);
    return rows.count;
  };
  return rows;
}

/**
 * Replay trace events against a parsed contract. events is
 * [{ line, event, session, device?, props }] in file order. Returns the trace
 * findings, each { id, severity, title, detail, count, rows } with the
 * first 10 offending rows.
 */
export function replayTrace(contract, events) {
  const out = [];
  const add = (id, title, detail, rows) => {
    if (rows.count === 0) return;
    const n = rows.count;
    const f = finding(id, 'warning', title(n, (one, many) => (n === 1 ? one : many)), detail);
    f.count = n;
    f.rows = rows.slice();
    out.push(f);
  };

  // Attempt id props per event, so the required check does not report them twice.
  const attemptFor = new Map();
  for (const a of contract.attemptIds) {
    for (const ev of a.events) {
      if (!attemptFor.has(ev)) attemptFor.set(ev, new Set());
      attemptFor.get(ev).add(a.prop);
    }
  }

  // trace_cumulative_decreased
  {
    const rows = collector();
    for (const c of contract.cumulative) {
      const last = new Map();
      for (const e of events) {
        const v = num(e.props[c.prop]);
        if (v === null) continue;
        const joinProp = c.join || contract.events.get(e.event)?.join || null;
        const joinVal = joinProp && !isEmpty(e.props[joinProp]) ? show(e.props[joinProp]) : null;
        const key = joinVal !== null ? `${joinProp}=${joinVal}` : `session=${e.session}`;
        const prev = last.get(key);
        if (prev && v < prev.value) {
          rows.push({
            line: e.line,
            event: e.event,
            session: e.session,
            detail: `${c.prop} went from ${prev.value} (line ${prev.line}) to ${v} within ${key}`,
          });
        }
        last.set(key, { value: v, line: e.line });
      }
    }
    add(
      'trace_cumulative_decreased',
      (n, p) => `${n} cumulative ${p('value', 'values')} went down`,
      'A prop the contract marks cumulative should never go down within the same join id (the event\'s join prop, ' +
        'or the session when it has none), in file order. A drop usually means the counter was reset on load or ' +
        'counted per scene.',
      rows,
    );
  }

  // trace_orphan_outcome
  {
    const rows = collector();
    for (const [name, spec] of contract.events) {
      if (!spec.pairsWith) continue;
      const openers = new Set();
      for (const e of events) {
        if (e.event === spec.pairsWith && !isEmpty(e.props[spec.join])) openers.add(show(e.props[spec.join]));
      }
      const attemptChecked = attemptFor.get(name)?.has(spec.join);
      for (const e of events) {
        if (e.event !== name) continue;
        const v = e.props[spec.join];
        if (isEmpty(v)) {
          if (attemptChecked) continue; // reported as trace_missing_attempt_id
          rows.push({ line: e.line, event: e.event, session: e.session, detail: `no ${spec.join}, so it cannot pair with ${spec.pairsWith}` });
        } else if (!openers.has(show(v))) {
          rows.push({ line: e.line, event: e.event, session: e.session, detail: `${spec.join}=${show(v)} never had a ${spec.pairsWith}` });
        }
      }
    }
    add(
      'trace_orphan_outcome',
      (n, p) => `${n} paired ${p('event', 'events')} without an opener`,
      'An event with pairs_with in the contract arrived for a join id that never had its opening event anywhere in ' +
        'the trace. Either the opener is not sent, or the two events carry different ids.',
      rows,
    );
  }

  // trace_missing_attempt_id
  {
    const rows = collector();
    for (const e of events) {
      for (const prop of attemptFor.get(e.event) || []) {
        if (isEmpty(e.props[prop])) rows.push({ line: e.line, event: e.event, session: e.session, detail: `no ${prop}` });
      }
    }
    add(
      'trace_missing_attempt_id',
      (n, p) => `${n} ${p('event', 'events')} without the attempt id`,
      'These events are in an attempt_ids scope of the contract but arrived without the id, so attempts cannot be ' +
        'counted or paired.',
      rows,
    );
  }

  // trace_missing_depth
  {
    const rows = collector();
    for (const e of events) {
      const spec = contract.events.get(e.event);
      if (!spec) continue;
      const skip = attemptFor.get(e.event) || new Set();
      for (const prop of new Set([...spec.required, ...spec.nonzero])) {
        if (skip.has(prop)) continue;
        const v = e.props[prop];
        if (isEmpty(v)) rows.push({ line: e.line, event: e.event, session: e.session, detail: `${prop} is missing or empty` });
        else if (spec.nonzero.includes(prop) && isZero(v)) {
          rows.push({ line: e.line, event: e.event, session: e.session, detail: `${prop} is 0, and the contract marks it nonzero` });
        }
      }
    }
    add(
      'trace_missing_depth',
      (n, p) => `${n} required ${p('prop', 'props')} missing, empty or zero`,
      'A prop the contract requires was absent or empty, or zero where the contract marks it nonzero (a depth, ' +
        'a count, a duration).',
      rows,
    );
  }

  // trace_repeated_earned
  {
    const rows = collector();
    for (const rule of contract.earnedOnce) {
      const seen = new Map();
      for (const e of events) {
        if (e.event !== rule.event) continue;
        const k = e.props[rule.key];
        if (isEmpty(k)) continue;
        const id = `${e.device != null ? `device:${e.device}` : `session:${e.session}`}\u0000${show(k)}`;
        const prev = seen.get(id);
        if (prev !== undefined && !isLoaded(e.props.loaded)) {
          rows.push({
            line: e.line,
            event: e.event,
            session: e.session,
            detail: `${rule.key}=${show(k)} was already emitted at line ${prev} on this ${e.device != null ? 'device' : 'session'}, and this one has no loaded: true`,
          });
        }
        if (prev === undefined) seen.set(id, e.line);
      }
    }
    add(
      'trace_repeated_earned',
      (n, p) => `${n} earned once ${p('event', 'events')} repeated`,
      'The contract says this event is earned once per key, but the same key was emitted again on one device (or ' +
        'in one session when the row has no device id) ' +
        'without a loaded: true marker. Mark the events replayed from a save as loaded: true so they read as a ' +
        'baseline, not a new unlock.',
      rows,
    );
  }

  return out;
}


/**
 * Read a trace file into compact records, one per event, holding only the
 * props the contract names. Returns
 * { events, lines, truncated, skipped, skippedLines }.
 */
export function readTraceRecords(contract, file) {
  const keep = contractProps(contract);
  const events = [];
  let skipped = 0;
  const skippedLines = [];
  const skip = (line, reason) => {
    skipped++;
    if (skippedLines.length < MAX_SKIPPED_LISTED) skippedLines.push({ line, reason });
  };
  const { lines, truncated } = readTraceLines(file, (text, line) => {
    if (text === null) return skip(line, `longer than ${MAX_LINE_CHARS / 1024} KB`);
    if (text.trim() === '') return;
    const parsed = parseTraceLine(text);
    if (parsed.error) return skip(line, parsed.error);
    for (const e of parsed.events) events.push(compact(e, line, keep));
  });
  return { events, lines, truncated, skipped, skippedLines };
}

/**
 * Read and replay a trace file. Returns the report's trace block:
 * { file, lines, checked, skipped, skippedLines, truncated, maxLines, findings }
 * where skippedLines lists the first 10 skipped lines as { line, reason }.
 */
export function runTrace(contract, file, label = file) {
  const { events, lines, truncated, skipped, skippedLines } = readTraceRecords(contract, file);
  const findings = replayTrace(contract, events);
  if (events.length === 0) {
    findings.unshift(
      finding(
        'trace_nothing_checked',
        'warning',
        'The trace file gave no event to check',
        lines === 0
          ? 'The trace file is empty, so nothing was replayed.'
          : `None of the ${lines} lines read is a JSON event with a name (event_name or event), so nothing was replayed. ` +
              'See the skipped lines below.',
      ),
    );
    findings[0].count = 1;
    findings[0].rows = [];
  }
  return {
    file: label,
    lines,
    checked: events.length,
    skipped,
    skippedLines,
    truncated,
    maxLines: MAX_TRACE_LINES,
    findings,
  };
}
