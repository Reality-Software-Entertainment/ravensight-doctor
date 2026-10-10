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
