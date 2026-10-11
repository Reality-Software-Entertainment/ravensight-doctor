// Project configuration for ravensight-doctor: ravensight.config.json in the
// scanned root, plus parsing for --track-fn and trackFunctions entries.

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'ravensight.config.json';

const CONFIG_KEYS = new Set(['$schema', 'trackFunctions', 'ignore', 'gitignore']);
// A function name, optionally dotted, with at most one ":" before the final
// segment for Lua method calls (telemetry:track). A leading "*." means any
// receiver (*.capture matches client.capture( and analytics.capture( alike).
const NAME_RE = /^(?:\*\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?::[A-Za-z_$][\w$]*)?$/;
const ENTRY_KEYS = new Set(['name', 'argIndex', 'paths']);
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
    // Keys other than name, argIndex and paths are ignored (loadConfig
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
 * key. Returns { trackFunctions, ignore, gitignore, unknownKeys } where
 * gitignore is undefined unless the file sets it and unknownKeys lists the
 * keys that were skipped.
 */
export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { trackFunctions: [], ignore: [], gitignore: undefined, unknownKeys: [] };
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
  const config = { trackFunctions: [], ignore: [], gitignore: undefined, unknownKeys };
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
  return config;
}
