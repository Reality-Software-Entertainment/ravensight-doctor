// The optional event contract: ravensight.contract.json in the scanned
// directory, or the file --contract names.
//
//   {
//     "events": {
//       "choice_made":    { "required": ["decision_id", "depth"], "nonzero": ["depth"] },
//       "choice_outcome": { "required": ["decision_id"], "pairs_with": "choice_made", "join": "decision_id" }
//     },
//     "cumulative": ["foreground_seconds"],
//     "attempt_ids": ["decision_id"],
//     "earned_once": { "event": "progress_unlocked", "key": "content_id" }
//   }
//
// The static check proves presence in source only: every event the
// contract names appears as a literal name in a track call, and a literal
// props object at a call site has every required key. It cannot see the
// values a game sends at runtime, so pairs, cumulative values, attempt ids,
// zero depths and repeated unlocks are checked only by --trace (trace.js),
// over the file you provide.

import fs from 'node:fs';
import path from 'node:path';
import { finding } from './checks.js';

export const CONTRACT_FILE = 'ravensight.contract.json';

const TOP_KEYS = new Set(['$schema', 'events', 'cumulative', 'attempt_ids', 'earned_once']);
const EVENT_KEYS = new Set(['required', 'pairs_with', 'join', 'nonzero']);
const MAX_LISTED = 10;

/** A problem with the contract file. */
export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractError';
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isName = (v) => typeof v === 'string' && v.trim() !== '';

function stringList(v, where) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => !isName(s))) {
    throw new ContractError(`${where} must be a list of non empty strings.`);
  }
  return v.map((s) => s.trim());
}

/**
 * Validate a parsed contract. Returns
 * { events: Map<name, { required, nonzero, pairsWith, join }>,
 *   cumulative: [{ prop, join }], attemptIds: [{ prop, events: Set }],
 *   earnedOnce: [{ event, key }], unknownKeys }
 * where cumulative join is null when it follows each event's own join.
 * Throws ContractError naming the problem.
 */
export function parseContract(raw, label = CONTRACT_FILE) {
  const fail = (msg) => {
    throw new ContractError(`${label}: ${msg}`);
  };
  if (!isObj(raw)) fail('must contain a JSON object.');
  const unknownKeys = Object.keys(raw).filter((k) => !TOP_KEYS.has(k));
  const events = new Map();
  if (raw.events !== undefined && !isObj(raw.events)) fail('"events" must be an object keyed by event name.');
  try {
    for (const [name, spec] of Object.entries(raw.events || {})) {
      if (!isName(name)) fail('an event name in "events" is empty.');
      if (!isObj(spec)) fail(`events["${name}"] must be an object.`);
      for (const k of Object.keys(spec)) if (!EVENT_KEYS.has(k)) unknownKeys.push(`events.${name}.${k}`);
      const required = stringList(spec.required, `events["${name}"].required`);
      const nonzero = stringList(spec.nonzero, `events["${name}"].nonzero`);
      if (spec.pairs_with !== undefined && !isName(spec.pairs_with)) {
        fail(`events["${name}"].pairs_with must be an event name.`);
      }
      if (spec.join !== undefined && !isName(spec.join)) fail(`events["${name}"].join must be a prop name.`);
      if (spec.pairs_with !== undefined && spec.join === undefined) {
        fail(`events["${name}"] has pairs_with but no join: name the prop that links it to "${spec.pairs_with}", like "run_id".`);
      }
      events.set(name, {
        required,
        nonzero,
        pairsWith: spec.pairs_with !== undefined ? spec.pairs_with.trim() : null,
        join: spec.join !== undefined ? spec.join.trim() : null,
      });
    }

    if (raw.cumulative !== undefined && !Array.isArray(raw.cumulative)) fail('"cumulative" must be a list.');
    const cumulative = (raw.cumulative || []).map((c, i) => {
      if (isName(c)) return { prop: c.trim(), join: null };
      if (isObj(c) && isName(c.prop) && (c.join === undefined || isName(c.join))) {
        return { prop: c.prop.trim(), join: c.join ? c.join.trim() : null };
      }
      return fail(`cumulative[${i}] must be a prop name or { "prop": "...", "join": "..." }.`);
    });

    if (raw.attempt_ids !== undefined && !Array.isArray(raw.attempt_ids)) fail('"attempt_ids" must be a list.');
    const attemptIds = (raw.attempt_ids || []).map((a, i) => {
      if (isName(a)) {
        const prop = a.trim();
        const scope = new Set();
        for (const [name, e] of events) {
          if (e.join === prop || e.required.includes(prop) || e.nonzero.includes(prop)) {
            scope.add(name);
            if (e.pairsWith && e.join === prop) scope.add(e.pairsWith);
          }
        }
        if (scope.size === 0) {
          fail(
            `attempt_ids[${i}] ("${prop}"): no event in "events" names it in required or join, so it applies to nothing. ` +
              `Add it to an event, or write { "prop": "${prop}", "events": ["..."] }.`,
          );
        }
        return { prop, events: scope };
      }
      if (isObj(a) && isName(a.prop)) {
        const list = stringList(a.events, `attempt_ids[${i}].events`);
        if (list.length === 0) fail(`attempt_ids[${i}].events must name at least one event.`);
        return { prop: a.prop.trim(), events: new Set(list) };
      }
      return fail(`attempt_ids[${i}] must be a prop name or { "prop": "...", "events": ["..."] }.`);
    });

    const earnedRaw = raw.earned_once === undefined ? [] : Array.isArray(raw.earned_once) ? raw.earned_once : [raw.earned_once];
    const earnedOnce = earnedRaw.map((e, i) => {
      if (!isObj(e) || !isName(e.event) || !isName(e.key)) {
        fail(`earned_once${Array.isArray(raw.earned_once) ? `[${i}]` : ''} must be { "event": "...", "key": "..." }.`);
      }
      return { event: e.event.trim(), key: e.key.trim() };
    });

    return { events, cumulative, attemptIds, earnedOnce, unknownKeys };
  } catch (err) {
    if (err instanceof ContractError) throw err;
    throw new ContractError(`${label}: ${err.message}`);
  }
}

/**
 * Load the contract. With file (from --contract) it must exist; without it
 * the default ravensight.contract.json in root is optional. Returns
 * { ...parseContract(), file } or null when there is none.
 */
export function loadContract(root, file) {
  const abs = file ? path.resolve(file) : path.join(root, CONTRACT_FILE);
  const label = file ? file : CONTRACT_FILE;
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if (!file && err && err.code === 'ENOENT') return null;
    throw new ContractError(`Could not read the contract ${label}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ContractError(`${label} is not valid JSON: ${err.message}`);
  }
  return { ...parseContract(raw, label), file: label };
}

/** Every event name the contract mentions: its events, pairs_with targets and earned_once events. */
export function contractEventNames(contract) {
  const names = new Set(contract.events.keys());
  for (const e of contract.events.values()) if (e.pairsWith) names.add(e.pairsWith);
  for (const e of contract.earnedOnce) names.add(e.event);
  return [...names];
}

/** The event names whose call sites need their literal props read: those with required keys. */
export function propEvents(contract) {
  return new Set([...contract.events].filter(([, e]) => e.required.length || e.nonzero.length).map(([n]) => n));
}

/**
 * The static contract findings. inventory is runChecks' inventory and
 * propSites its [{ file, line, name, keys }] for the propEvents names.
 * Returns { findings, summary } where summary is the report's contract
 * block: { file, events, matched, missing, propSitesChecked, propsUnproven }.
 *
 * A props object at a call through the project's own track function that
 * lacks a required key is contract_prop_unproven (info) unless the entry's
 * enriches lists the key (then nothing) or the entry declares enriches
 * without it (then contract_prop_missing, as for a direct SDK call).
 */
export function contractFindings(contract, inventory, propSites) {
  const findings = [];
  const seen = new Set(inventory.eventNames.map((e) => e.name));
  const names = contractEventNames(contract);
  const missing = names.filter((n) => !seen.has(n));
  const matched = names.length - missing.length;

  if (names.length > 0 && matched === 0) {
    findings.push(
      finding(
        'contract_unmatched',
        'info',
        'The contract names no event found in the scan',
        `None of the ${names.length} event names in ${contract.file} appears as a literal event name in a track call ` +
          '(for example ' +
          names.slice(0, 3).join(', ') +
          '). Check that you scanned the right directory, or name your own track functions with --track-fn so ' +
          'their event names are read.',
      ),
    );
  } else {
    for (const n of missing) {
      findings.push(
        finding(
          'contract_event_missing',
          'warning',
          `Contract event "${n}" is not tracked anywhere in the scanned source`,
          `${contract.file} names the event "${n}", but no track call in the scanned files uses it as a literal ` +
            'event name. Add the call, fix the spelling, or remove it from the contract. A name built at runtime is ' +
            'not seen by the static scan.',
        ),
      );
    }
  }

  let unproven = 0;
  for (const site of propSites) {
    const spec = contract.events.get(site.name);
    if (!spec) continue;
    const need = [...new Set([...spec.required, ...spec.nonzero])];
    // Keys the wrapper's trackFunctions entry says it adds centrally are
    // never missing at its call sites.
    const added = new Set(site.enriches || []);
    const absent = need.filter((k) => !site.keys.includes(k) && !added.has(k));
    if (absent.length === 0) continue;
    const has = site.keys.length ? site.keys.slice(0, MAX_LISTED).join(', ') : 'no keys';
    if (site.wrapper && !site.enriches) {
      // The call goes through the project's own function, which may merge
      // keys into the payload before the SDK sees it. Source cannot show
      // that, so this is not a defect, only something the trace must show.
      unproven++;
      findings.push(
        finding(
          'contract_prop_unproven',
          'info',
          `"${site.name}" via ${site.fn}: ${absent.join(', ')} not provable statically; the runtime trace is the evidence`,
          `The props object at this call has ${has}. ${contract.file} requires ${absent.join(', ')} on "${site.name}", ` +
            `but ${site.fn} is your own track function and may add keys before it calls the SDK, so this is not ` +
            'provable statically; the runtime trace is the evidence (--trace). If the wrapper adds them, list them in ' +
            `its trackFunctions entry as "enriches": [${absent.map((k) => JSON.stringify(k)).join(', ')}].`,
          site.file,
          site.line,
        ),
      );
      continue;
    }
    findings.push(
      finding(
        'contract_prop_missing',
        'warning',
        `"${site.name}" is tracked without required prop${absent.length === 1 ? '' : 's'} ${absent.join(', ')}`,
        `The props object at this call has ${has}, but ` +
          `${contract.file} requires ${absent.join(', ')} on "${site.name}". ` +
          (site.enriches
            ? `${site.fn} declares that it adds ${site.enriches.join(', ')} (enriches), and not these. `
            : '') +
          'This proves the key is missing in source; ' +
          'whether the values sent at runtime are right is a job for --trace.',
        site.file,
        site.line,
      ),
    );
  }

  return {
    findings,
    summary: { file: contract.file, events: names.length, matched, missing, propSitesChecked: propSites.length, propsUnproven: unproven },
  };
}
