// Project configuration for ravensight-doctor: ravensight.config.json in the
// scanned root, plus parsing for --track-fn and trackFunctions entries.

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'ravensight.config.json';

const CONFIG_KEYS = new Set(['$schema', 'trackFunctions', 'ignoreCalls', 'ignore', 'gitignore', 'forwarders', 'ingestKey']);
// A function name, optionally dotted, with at most one ":" before the final
// segment for Lua method calls (telemetry:track). A leading "*." means any
// receiver (*.capture matches client.capture( and analytics.capture( alike).
const NAME_RE = /^(?:\*\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?::[A-Za-z_$][\w$]*)?$/;
const ENTRY_KEYS = new Set(['name', 'argIndex', 'paths', 'enriches']);
// enriches: keys the wrapper adds to every payload before calling the SDK.
const MAX_ENRICHES = 50;
const PROP_KEY_RE = /^[A-Za-z_$][\w$.-]*$/;
// Where the ingest key comes from when it is not in the source: injected
// into the build (an xcconfig expanded into Info.plist, a CI secret) or read
// from the environment at startup.
export const INGEST_KEY_SOURCES = new Set(['source', 'build', 'env']);
const MAX_PATHS = 50;
// "name@N": the event name is argument N.
const AT_RE = /^(.*)@(\d+)$/;
const MAX_ARG_INDEX = 9;

/** A problem with ravensight.config.json or a --track-fn value. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse one track function spec: "capture", "*.capture",
 * "Analytics.logEvent", "telemetry:track", "capture@1" or
 * { name: "track_event", argIndex: 1, paths: ["server/**"] }.
 * Returns { name, argIndex, source } plus paths when the entry has them.
 * Throws ConfigError when it is not usable.
 */
export function parseTrackFnSpec(spec, source = 'flag') {
  let name;
  let argIndex = 0;
  let paths;
  let enriches;
  if (typeof spec === 'string') {
    name = spec.trim();
    const at = AT_RE.exec(name);
    if (at) {
      name = at[1];
      argIndex = Number(at[2]);
      if (argIndex > MAX_ARG_INDEX) {
        throw new ConfigError(
          `Track function "${name}": the argument position after @ must be a whole number from 0 to ${MAX_ARG_INDEX}.`,
        );
      }
    }
  } else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    // Keys other than name, argIndex, paths and enriches are ignored (loadConfig
    // reports them).
    if (typeof spec.name !== 'string') {
      throw new ConfigError('A track function entry needs a "name" string.');
    }
    name = spec.name.trim();
    if (spec.argIndex !== undefined) {
      if (!Number.isInteger(spec.argIndex) || spec.argIndex < 0 || spec.argIndex > MAX_ARG_INDEX) {
        throw new ConfigError(
          `Track function "${name}": argIndex must be a whole number from 0 to ${MAX_ARG_INDEX}.`,
        );
      }
      argIndex = spec.argIndex;
    }
    if (spec.paths !== undefined) {
      if (
        !Array.isArray(spec.paths) ||
        spec.paths.length === 0 ||
        spec.paths.length > MAX_PATHS ||
        spec.paths.some((p) => typeof p !== 'string' || p.trim() === '' || p.trim().startsWith('!'))
      ) {
        throw new ConfigError(
          `Track function "${name}": paths must be a list of 1 to ${MAX_PATHS} glob patterns relative to the ` +
            'scanned directory, like "server/**" (no "!" negation).',
        );
      }
      paths = spec.paths.map((p) => p.trim().replace(/^(?:\.\/)+/, ''));
      const bad = spec.paths.find((p) => p.includes('\\'));
      if (bad !== undefined) {
        throw new ConfigError(
          `Track function "${name}": the path pattern "${bad}" has a backslash. Use forward slashes, like "server/**".`,
        );
      }
      if (paths.some((p) => p === '' || p === '.')) {
        throw new ConfigError(`Track function "${name}": a path pattern must name files, like "server/**", not "./".`);
      }
    }
    if (spec.enriches !== undefined) {
      if (
        !Array.isArray(spec.enriches) ||
        spec.enriches.length === 0 ||
        spec.enriches.length > MAX_ENRICHES ||
        spec.enriches.some((k) => typeof k !== 'string' || !PROP_KEY_RE.test(k.trim()))
      ) {
        throw new ConfigError(
          `Track function "${name}": enriches must be a list of 1 to ${MAX_ENRICHES} prop keys the wrapper adds ` +
            'to every payload, like ["run_id", "rs_kind"].',
        );
      }
      enriches = [...new Set(spec.enriches.map((k) => k.trim()))];
    }
  } else {
    throw new ConfigError('A track function must be a name or an object with "name" and "argIndex".');
  }
  if (!NAME_RE.test(name)) {
    throw new ConfigError(
      `Invalid track function name "${name}". Use a function name like capture, a dotted ` +
        'name like Analytics.logEvent, *.capture for a call on any receiver, a Lua method like ' +
        'telemetry:track, and optionally @N for the argument that holds the event name, like capture@1.',
    );
  }
  const parsed = { name, argIndex, source };
  if (paths) parsed.paths = paths;
  if (enriches) parsed.enriches = enriches;
  return parsed;
}

/**
 * Throw a ConfigError when two entries without paths share a name: the
 * doctor could not tell which argument holds the event name. label(i)
 * names entry i in the message.
 */
function rejectPathlessDuplicates(specs, label) {
  const first = new Map();
  specs.forEach((s, i) => {
    if (s.paths) return;
    if (first.has(s.name)) {
      throw new ConfigError(
        `${label(first.get(s.name))} and ${label(i)} both name the track function "${s.name}" without paths. ` +
          'Keep one, or give each the paths it applies to.',
      );
    }
    first.set(s.name, i);
  });
}

/** Split repeatable --track-fn values ("a,b") into parsed specs. */
export function parseTrackFnFlags(values) {
  const specs = [];
  const raw = [];
  for (const v of values) {
    for (const part of String(v).split(',')) {
      if (part.trim() === '') continue;
      specs.push(parseTrackFnSpec(part, 'flag'));
      raw.push(part.trim());
    }
  }
  rejectPathlessDuplicates(specs, (i) => `--track-fn ${raw[i]}`);
  return specs;
}

/**
 * Load ravensight.config.json from root. A missing file is an empty
 * config. Throws ConfigError for invalid JSON or a wrong type on a known
 * key. Returns { trackFunctions, ignoreCalls, ignore, gitignore, forwarders,
 * ingestKey: { source }, unknownKeys } where
 * gitignore is undefined unless the file sets it and unknownKeys lists the
 * keys that were skipped.
 */
export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyConfig([]);
    throw new ConfigError(`Could not read ${CONFIG_FILE}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${CONFIG_FILE} must contain a JSON object.`);
  }
  // Unknown keys are skipped, not fatal, so a config written for a later
  // doctor still loads; the caller prints one note naming them.
  const unknownKeys = Object.keys(raw).filter((k) => !CONFIG_KEYS.has(k));
  const config = emptyConfig(unknownKeys);
  if (raw.trackFunctions !== undefined) {
    if (!Array.isArray(raw.trackFunctions)) {
      throw new ConfigError(`${CONFIG_FILE}: trackFunctions must be an array.`);
    }
    raw.trackFunctions.forEach((entry, i) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        for (const k of Object.keys(entry)) {
          if (!ENTRY_KEYS.has(k)) unknownKeys.push(`trackFunctions[${i}].${k}`);
        }
      }
    });
    try {
      config.trackFunctions = raw.trackFunctions.map((s) => parseTrackFnSpec(s, 'config'));
      rejectPathlessDuplicates(config.trackFunctions, (i) => `trackFunctions[${i}] ("${config.trackFunctions[i].name}")`);
    } catch (err) {
      throw new ConfigError(`${CONFIG_FILE}: ${err.message}`);
    }
  }
  if (raw.ignoreCalls !== undefined) {
    if (!Array.isArray(raw.ignoreCalls)) {
      throw new ConfigError(`${CONFIG_FILE}: ignoreCalls must be an array of call names.`);
    }
    config.ignoreCalls = raw.ignoreCalls.map((entry, i) => {
      const name = typeof entry === 'string' ? entry.trim() : '';
      if (!NAME_RE.test(name)) {
        throw new ConfigError(
          `${CONFIG_FILE}: ignoreCalls[${i}] must be a call name like vendor.capture, or *.capture for any receiver.`,
        );
      }
      return name;
    });
  }
  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore) || raw.ignore.some((p) => typeof p !== 'string')) {
      throw new ConfigError(`${CONFIG_FILE}: ignore must be an array of pattern strings.`);
    }
    config.ignore = raw.ignore.slice();
  }
  if (raw.gitignore !== undefined) {
    if (typeof raw.gitignore !== 'boolean') {
      throw new ConfigError(`${CONFIG_FILE}: gitignore must be true or false.`);
    }
    config.gitignore = raw.gitignore;
  }
  if (raw.forwarders !== undefined) {
    if (!Array.isArray(raw.forwarders) || raw.forwarders.length > MAX_FORWARDERS) {
      throw new ConfigError(`${CONFIG_FILE}: forwarders must be a list of at most ${MAX_FORWARDERS} function names.`);
    }
    config.forwarders = raw.forwarders.map((entry, i) => {
      const name = typeof entry === 'string' ? entry.trim() : '';
      if (!FORWARDER_RE.test(name)) {
        throw new ConfigError(
          `${CONFIG_FILE}: forwarders[${i}] must be the name of a function or closure property that passes the ` +
            'event name on, like TelemetrySink.send or send.',
        );
      }
      return name;
    });
  }
  if (raw.ingestKey !== undefined) {
    const k = raw.ingestKey;
    if (!k || typeof k !== 'object' || Array.isArray(k) || !INGEST_KEY_SOURCES.has(k.source)) {
      throw new ConfigError(
        `${CONFIG_FILE}: ingestKey must be { "source": "build" } (injected at build time), { "source": "env" } ` +
          '(read from the environment at startup) or { "source": "source" } (in the source tree, the default).',
      );
    }
    for (const key of Object.keys(k)) if (key !== 'source') unknownKeys.push(`ingestKey.${key}`);
    config.ingestKey = { source: k.source };
  }
  return config;
}

function emptyConfig(unknownKeys) {
  return {
    trackFunctions: [],
    ignoreCalls: [],
    ignore: [],
    gitignore: undefined,
    forwarders: [],
    ingestKey: { source: 'source' },
    unknownKeys,
  };
}

// A forwarder: a plain or dotted name, no wildcard, no Lua method.
const FORWARDER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const MAX_FORWARDERS = 20;
