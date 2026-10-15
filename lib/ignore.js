// A small subset of .gitignore matching for ravensight-doctor.
//
// Supported: blank lines and # comments (skipped), basename patterns that
// match at any depth, patterns anchored to the root by a leading or middle
// slash, *, ?, ** and a trailing slash for directories only. A negation (!)
// line keeps whatever it matches scanned, wherever it sits in the file, so
// *.json plus !package.json still scans package.json. Only the root
// .gitignore is read, never nested ones. Anything a pattern cannot express
// is simply scanned.

function escapeRe(c) {
  return /[\\^$.|+()[\]{}]/.test(c) ? '\\' + c : c;
}

/** Translate one glob body (no leading or trailing slash) to a regex source. */
function globToRe(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('/**/', i)) {
      re += '/(?:.*/)?';
      i += 4;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      re += '/.+';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      re += '[^/]*';
      i += 1;
    } else if (glob[i] === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += escapeRe(glob[i]);
      i += 1;
    }
  }
  return re;
}

/**
 * Compile ignore patterns (a .gitignore body or an array of lines) into
 * a predicate (rel, isDir) => boolean, where rel is a forward slash path
 * relative to the scan root.
 */
export function compileIgnore(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  const rules = [];
  const keeps = [];
  for (const raw of lines) {
    let p = String(raw).trim();
    if (p === '' || p.startsWith('#')) continue;
    let target = rules;
    if (p.startsWith('!')) {
      target = keeps;
      p = p.slice(1);
    }
    let dirOnly = false;
    if (p.endsWith('/')) {
      dirOnly = true;
      p = p.replace(/\/+$/, '');
    }
    if (p === '') continue;
    // A slash anywhere but the end anchors the pattern to the root, so it
    // is tested on the whole path. A leading **/ still matches at any
    // depth because it compiles to an optional directory prefix.
    const onPath = p.includes('/');
    p = p.replace(/^\/+/, '');
    if (p === '') continue;
    target.push({ re: new RegExp('^' + globToRe(p) + '$'), dirOnly, onPath });
  }
  const matches = (list, rel, base, isDir) =>
    list.some((r) => !(r.dirOnly && !isDir) && r.re.test(r.onPath ? rel : base));
  return (rel, isDir) => {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    return matches(rules, rel, base, isDir) && !matches(keeps, rel, base, isDir);
  };
}

/**
 * Compile one trackFunctions "paths" pattern, in the same glob subset as
 * the ignore patterns above (no negation): a pattern without a slash
 * matches a basename at any depth, a slash anywhere (leading, middle or
 * trailing after a name, as in "src/**", "/src/**" or "src/lib") anchors it
 * to the scan root, so "src/**" covers src/a.js and never
 * dashboard/src/a.js, a leading "./" is dropped, and
 * a pattern that matches a directory covers every file under it, so
 * "server", "server/" and "server/**" all cover server/api/a.js (and only
 * the bare "server" also covers lib/server/b.js). Returns
 * { test(rel) => boolean, specificity } where specificity is the number of
 * characters in the pattern that are not wildcards or slashes, used to pick
 * the most specific of several matching patterns.
 */
export function compilePathPattern(pattern) {
  let p = String(pattern).trim().replace(/^(?:\.\/)+/, '');
  // Any slash anchors, a trailing one included ("src/" is the top level
  // src directory, unlike the ignore patterns above).
  const onPath = p.includes('/');
  let dirOnly = false;
  if (p.endsWith('/')) {
    dirOnly = true;
    p = p.replace(/\/+$/, '');
  }
  p = p.replace(/^\/+/, '');
  const re = new RegExp('^' + globToRe(p) + '$');
  const specificity = p.replace(/[*?/]/g, '').length;
  const test = (rel) => {
    const parts = rel.split('/');
    // The file itself, then every directory above it.
    for (let n = parts.length; n >= 1; n--) {
      const isDir = n < parts.length;
      if (dirOnly && !isDir) continue;
      const sub = parts.slice(0, n).join('/');
      if (re.test(onPath ? sub : parts[n - 1])) return true;
    }
    return false;
  };
  return { test, specificity };
}
