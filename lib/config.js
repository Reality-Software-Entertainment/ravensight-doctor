// Project configuration for ravensight-doctor: ravensight.config.json in the
// scanned root, plus parsing for --track-fn and trackFunctions entries.

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'ravensight.config.json';

const CONFIG_KEYS = new Set(['$schema', 'trackFunctions', 'ignore', 'gitignore']);
const NAME_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const MAX_ARG_INDEX = 9;

/** A problem with ravensight.config.json or a --track-fn value. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse one track function spec: "capture", "Analytics.logEvent" or
 * { name: "track_event", argIndex: 1 }. Returns
 * { name, argIndex, source }. Throws ConfigError when it is not usable.
 */
export function parseTrackFnSpec(spec, source = 'flag') {
  let name;
  let argIndex = 0;
  if (typeof spec === 'string') {
    name = spec.trim();
  } else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    for (const k of Object.keys(spec)) {
      if (k !== 'name' && k !== 'argIndex') {
        throw new ConfigError(`Unknown key "${k}" in a track function entry. Use "name" and "argIndex".`);
      }
    }
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
  } else {
    throw new ConfigError('A track function must be a name or an object with "name" and "argIndex".');
  }
  if (!NAME_RE.test(name)) {
    throw new ConfigError(
      `Invalid track function name "${name}". Use a function name like capture or a dotted ` +
        'name like Analytics.logEvent.',
    );
  }
  return { name, argIndex, source };
}

/** Split repeatable --track-fn values ("a,b") into parsed specs. */
export function parseTrackFnFlags(values) {
  const specs = [];
  for (const v of values) {
    for (const part of String(v).split(',')) {
      if (part.trim() === '') continue;
      specs.push(parseTrackFnSpec(part, 'flag'));
    }
  }
  return specs;
}

/**
 * Load ravensight.config.json from root. A missing file is an empty
 * config. Throws ConfigError for invalid JSON, unknown keys or wrong types.
 * Returns { trackFunctions, ignore, gitignore } where gitignore is
 * undefined unless the file sets it.
 */
export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { trackFunctions: [], ignore: [], gitignore: undefined };
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
  for (const k of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(k)) {
      throw new ConfigError(
        `${CONFIG_FILE}: unknown key "${k}". Known keys: trackFunctions, ignore, gitignore.`,
      );
    }
  }
  const config = { trackFunctions: [], ignore: [], gitignore: undefined };
  if (raw.trackFunctions !== undefined) {
    if (!Array.isArray(raw.trackFunctions)) {
      throw new ConfigError(`${CONFIG_FILE}: trackFunctions must be an array.`);
    }
    try {
      config.trackFunctions = raw.trackFunctions.map((s) => parseTrackFnSpec(s, 'config'));
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
