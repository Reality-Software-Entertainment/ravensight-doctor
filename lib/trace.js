// Trace replay: the contract's runtime rules checked over a JSONL file of
// events the caller provides (--trace). This is a check of that file, not
// a proof of production behaviour.
//
// Each line is one event, in either shape:
//   { "event_name": "...", "ts": "...", "session_id": "...", "props": { ... } }
//   { "event": "...", "data": { ... }, "timestamp": "..." }   (the SDK batch shape)
// props may also be a JSON string. Blank lines are skipped; a line that is
// not a JSON object with an event name is counted as skipped. At most
// MAX_TRACE_LINES lines are read and the rest is ignored with a note.

import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { finding } from './checks.js';

export const MAX_TRACE_LINES = 50000;
const MAX_LINE_CHARS = 1024 * 1024;
const MAX_ROWS = 10;
const NO_SESSION = '(no session)';

/**
 * Read at most maxLines lines of file without reading the rest. Returns
 * { lines: string[], truncated } where truncated says non blank text came
 * after the last line read. A line longer than 1 MB is replaced by null.
 */
export function readTraceLines(file, maxLines = MAX_TRACE_LINES) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder('utf8');
  const lines = [];
  let cur = '';
  let oversize = false;
  let truncated = false;
  const push = () => {
    lines.push(oversize ? null : cur);
    cur = '';
    oversize = false;
  };
  try {
    outer: for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      const chunk = n === 0 ? decoder.end() : decoder.write(buf.subarray(0, n));
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf('\n', from);
        const piece = chunk.slice(from, nl === -1 ? undefined : nl);
        if (lines.length >= maxLines) {
          if (piece.trim() !== '' || (nl !== -1 && chunk.slice(nl + 1).trim() !== '')) {
            truncated = true;
            break outer;
          }
          if (nl === -1) break;
          from = nl + 1;
          continue;
        }
        if (!oversize) {
          if (cur.length + piece.length > MAX_LINE_CHARS) {
            oversize = true;
            cur = '';
          } else cur += piece;
        }
        if (nl === -1) break;
        push();
        from = nl + 1;
      }
      if (n === 0) {
        if ((cur !== '' || oversize) && lines.length < maxLines) push();
        break;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { lines, truncated };
}

/** One trace line as { event, session, ts, props } or null when it is not an event. */
export function parseTraceLine(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
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
  if (!props || typeof props !== 'object' || Array.isArray(props)) props = {};
  const sid = [o.session_id, o.sessionId, props.session_id].find((v) => typeof v === 'string' || typeof v === 'number');
  return { event, session: sid != null ? String(sid) : NO_SESSION, ts: o.ts ?? o.timestamp ?? null, props };
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

/**
 * Replay trace events against a parsed contract. events is
 * [{ line, event, session, ts, props }] in file order. Returns the trace
 * findings, each { id, severity, title, detail, count, rows } with the
 * first 10 offending rows.
 */
export function replayTrace(contract, events) {
  const out = [];
  const add = (id, title, detail, rows) => {
    if (rows.length === 0) return;
    const n = rows.length;
    const f = finding(id, 'warning', title(n, (one, many) => (n === 1 ? one : many)), detail);
    f.count = rows.length;
    f.rows = rows.slice(0, MAX_ROWS);
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
    const rows = [];
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
    const rows = [];
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
    const rows = [];
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
    const rows = [];
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
    const rows = [];
    for (const rule of contract.earnedOnce) {
      const seen = new Map();
      for (const e of events) {
        if (e.event !== rule.event) continue;
        const k = e.props[rule.key];
        if (isEmpty(k)) continue;
        const id = `${e.session}\u0000${show(k)}`;
        const prev = seen.get(id);
        if (prev !== undefined && !isLoaded(e.props.loaded)) {
          rows.push({
            line: e.line,
            event: e.event,
            session: e.session,
            detail: `${rule.key}=${show(k)} was already emitted at line ${prev} in this session, and this one has no loaded: true`,
          });
        }
        if (prev === undefined) seen.set(id, e.line);
      }
    }
    add(
      'trace_repeated_earned',
      (n, p) => `${n} earned once ${p('event', 'events')} repeated in a session`,
      'The contract says this event is earned once per key, but the same key was emitted again in one session ' +
        'without a loaded: true marker. Mark the events replayed from a save as loaded: true so they read as a ' +
        'baseline, not a new unlock.',
      rows,
    );
  }

  return out;
}

/**
 * Read and replay a trace file. Returns the report's trace block:
 * { file, lines, checked, skipped, truncated, maxLines, findings }.
 */
export function runTrace(contract, file, label = file) {
  const { lines, truncated } = readTraceLines(file);
  const events = [];
  let skipped = 0;
  lines.forEach((text, i) => {
    if (text !== null && text.trim() === '') return;
    const e = text === null ? null : parseTraceLine(text);
    if (!e) {
      skipped++;
      return;
    }
    events.push({ line: i + 1, ...e });
  });
  return {
    file: label,
    lines: lines.length,
    checked: events.length,
    skipped,
    truncated,
    maxLines: MAX_TRACE_LINES,
    findings: replayTrace(contract, events),
  };
}
