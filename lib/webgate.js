// Where a web game starts the game SDK.
//
// A browser game that creates the gameplay client at app start, or on a
// public page (landing, pricing, sign in), opens a game session for every
// website visitor, and each one counts as a player. This reads the source
// for the client's construction (`new Ravensight(...)`, or the name the
// project imports it as) and warns when it runs:
//
//   - at the top of a module: the app's entry, a root component, a public
//     page, or any browser module, which creates it as soon as it is first
//     imported;
//   - inside a named function that the same module calls at its top, or that
//     an entry, root component or public page calls (one hop: the function
//     itself, or a function in its own file that calls it).
//
// Only for a JavaScript project that shows public pages: a client router or
// an app framework with routes in package.json, a pages/ or routes/ folder,
// a file named like a public page, or more than one HTML page. A game whose
// page is the game (an HTML5 export) never sees this. Server files are left
// out: a server creates its client at startup by design. It is a static
// heuristic, and the message says so.

import { stripComments, extOf } from './comments.js';
import { finding, callScopeExclusion } from './checks.js';

export const WEB_GAMES_DOCS = 'https://ravensight.io/docs/web-games/';
const ID = 'game_sdk_outside_game';
const MAX_FINDINGS = 5;

const SCRIPT_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'html', 'htm']);
// A client router or an app framework whose apps have routes.
const ROUTED_DEPS = new Set([
  'vue-router', 'react-router', 'react-router-dom', '@tanstack/react-router', '@tanstack/router', 'wouter',
  'preact-router', '@angular/router', 'svelte-routing', 'svelte-spa-router', '@sveltejs/kit', 'next', 'nuxt',
  'astro', '@remix-run/react', '@solidjs/router', 'gatsby', '@reach/router', 'page',
]);
const PAGE_DIR_RE = /(^|\/)(pages|routes)\//i;
const SERVER_PATH_RE = /(^|\/)(server|servers|api|backend|functions|lambdas?|workers?|scripts|bin|cli)\/|\.server\.[cm]?[jt]sx?$/i;
const NODE_IMPORT_RE = /\bfrom\s+['"](?:node:[\w/]+|express|fastify|koa|http|https|fs|path|net)['"]|\brequire\(\s*['"](?:node:[\w/]+|express|fastify|koa|http|https|fs)['"]\s*\)/;
// Basenames, lower case, with Page, View, Screen or Route and separators
// removed (LandingPage, sign-in, HomeView).
const PUBLIC_NAMES = new Set(['landing', 'home', 'homepage', 'welcome', 'marketing', 'pricing', 'plans', 'about', 'blog', 'login', 'signin', 'signup', 'register', 'auth']);
const ROOT_NAMES = new Set(['app', 'layout', 'root', 'document']);
const ENTRY_NAMES = new Set(['main', 'index', 'entry', 'bootstrap', 'client']);
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'try', 'new', 'typeof', 'await']);

function normalizedName(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.indexOf('.');
  const stem = dot <= 0 ? base : base.slice(0, dot);
  return stem.replace(/(Page|View|Screen|Route)$/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/** 'public', 'root', 'entry' or 'module'. */
function fileKind(rel) {
  const name = normalizedName(rel);
  const ext = extOf(rel);
  const inPages = PAGE_DIR_RE.test(rel);
  if (PUBLIC_NAMES.has(name) || (inPages && name === 'index')) return 'public';
  if (ROOT_NAMES.has(name)) return 'root';
  if (ext === 'html' || ext === 'htm') return 'entry';
  if (!inPages && ENTRY_NAMES.has(name)) return 'entry';
  return 'module';
}

/** Why the project looks like a site with public pages, or null. */
function siteSignal(files, read, inScope) {
  const pkg = read('package.json');
  if (pkg) {
    try {
      const json = JSON.parse(pkg);
      const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };
      if (Object.keys(deps).some((name) => ROUTED_DEPS.has(name))) return 'router';
    } catch {
      // An unreadable package.json is reported elsewhere.
    }
  }
  let pages = 0;
  for (const f of files) {
    if (!inScope(f.rel) || SERVER_PATH_RE.test(f.rel)) continue;
    const ext = extOf(f.rel);
    if (!SCRIPT_EXTS.has(ext)) continue;
    if (PAGE_DIR_RE.test(f.rel)) return 'pages';
    if (PUBLIC_NAMES.has(normalizedName(f.rel))) return 'pages';
    if ((ext === 'html' || ext === 'htm') && ++pages > 1) return 'pages';
  }
  return null;
}

/** Blank string and template literal contents, keeping length and newlines. */
function blankStrings(code) {
  const out = code.split('');
  let quote = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') {
        out[i] = ' ';
        if (code[i + 1] !== '\n') out[i + 1] = ' ';
        i++;
        continue;
      }
      if (ch === quote || (ch === '\n' && quote !== '`')) {
        quote = null;
        continue;
      }
      if (ch !== '\n') out[i] = ' ';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      // A quote right after a letter is JSX text (Don't), not a string.
      if (ch === "'" && /[A-Za-z0-9]/.test(code[i - 1] || '')) continue;
      quote = ch;
    }
  }
  return out.join('');
}

/** In a component file, keep only the <script> bodies; markup braces are not code. */
function scriptOnly(code, rel) {
  if (!['vue', 'svelte'].includes(extOf(rel))) return code;
  const out = code.split('').map((ch) => (ch === '\n' ? ch : ' '));
  const open = /<script(?=[\s>])[^>]*>/gi;
  let m;
  while ((m = open.exec(code)) !== null) {
    const start = m.index + m[0].length;
    const close = code.indexOf('</script', start);
    const end = close === -1 ? code.length : close;
    for (let k = start; k < end; k++) out[k] = code[k];
    open.lastIndex = end;
  }
  return out.join('');
}

function matchingBrace(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i;
  }
  return code.length;
}

function depthAt(code, index) {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

const lineOf = (code, index) => code.slice(0, index).split('\n').length;

/** Function bodies in blanked code: { name (null for an anonymous one), at, start, end }. */
function functionRanges(code) {
  const ranges = [];
  const add = (name, at, brace) => ranges.push({ name, at, start: brace, end: matchingBrace(code, brace) });
  const patterns = [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]*)?\{/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s+)?(?:function\b[^(]*\([^)]*\)|\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=;{]*)?(?:=>)?\s*\{/g,
    /(?:^|[\s;,{}])(?:async\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]*)?\{/gm,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      if (KEYWORDS.has(m[1])) continue;
      const at = m.index + m[0].indexOf(m[1]);
      if (ranges.some((r) => r.at === at)) continue;
      add(m[1], at, m.index + m[0].length - 1);
    }
  }
  for (const m of code.matchAll(/(?:=>|\bfunction\s*\([^)]*\))\s*\{/g)) {
    const brace = m.index + m[0].length - 1;
    if (!ranges.some((r) => r.start === brace)) add(null, -1, brace);
  }
  return ranges;
}

const inside = (r, index) => r.start < index && index < r.end;

/** The identifiers the file constructs the game client as. */
function clientNames(code) {
  const names = new Set(['Ravensight']);
  for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]ravensight['"]/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bimport\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]ravensight['"]/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().match(/^(?:default|Ravensight)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (alias) names.add(alias[1]);
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]ravensight['"]\s*\)/g)) names.add(m[1]);
  // A dynamic import destructured under another name: ({ Ravensight: Client }).
  if (/\bimport\(\s*['"]ravensight['"]\s*\)/.test(code)) {
    for (const m of code.matchAll(/\{[^{}]*?\b(?:Ravensight|default)\s*:\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  }
  return names;
}

// An if condition on one of these is a route or sign in gate: the code only
// runs inside the game, or for a player who signed in.
const GATE_RE = /\b(?:inApp|isApp\w*|\w*AppRoute|\w*AppPage|\w*GameRoute|inGame|isInGame|isPlaying|requiresAuth|isSignedIn|signedIn|isLoggedIn|loggedIn|isAuthenticated|authenticated|currentUser|userId|user|account|player|playerId)\b/;

/** Whether the code between start and end has an if condition naming a gate. */
function gated(code, start, end) {
  const body = code.slice(start, end);
  for (const m of body.matchAll(/\bif\s*\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')' && --depth === 0) break;
    }
    if (GATE_RE.test(body.slice(m.index, i))) return true;
  }
  return false;
}

/**
 * The named functions in a file that reach target, each with the function it
 * calls on the way (parent), so a path can be walked back down to target.
 */
function callersOf(code, ranges, headers, target) {
  const parent = new Map([[target.name, null]]);
  const queue = [target.name];
  while (queue.length) {
    const callee = queue.shift();
    const calls = callsAt(code, callee, headers);
    for (const r of ranges) {
      if (!r.name || parent.has(r.name) || !calls.some((i) => inside(r, i))) continue;
      parent.set(r.name, callee);
      queue.push(r.name);
    }
  }
  return parent;
}

/** Where code calls name, leaving out its definitions (headers lists their name positions). */
function callsAt(code, name, headers) {
  const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
  return [...code.matchAll(re)]
    .map((m) => m.index)
    .filter((i) => !headers.has(i) && !/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, i - 20), i)));
}

function importsModule(text, rel) {
  const base = normalizedBase(rel);
  const re = new RegExp(`(?:from\\s*|import\\(\\s*|require\\(\\s*)['"][^'"]*/${base.replace(/[.$]/g, '\\$&')}(?:\\.[cm]?[jt]sx?|\\.vue|\\.svelte)?['"]`);
  return re.test(text);
}

function normalizedBase(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

const ADVICE =
  ' In a web game that shares a site with public pages, that opens a game session for every visitor, landing and ' +
  'marketing pages included, and each one counts as a player. Create the game client only on in-game routes, for a ' +
  'player who is playing, use the website tracker (createSiteTracker) on public pages, and call identify when a ' +
  `player signs in: ${WEB_GAMES_DOCS}. The doctor reads source, not your routes at runtime, so this can be a false ` +
  'alarm: if this page is the game itself, or this code only ever runs inside the game, nothing needs to change. ' +
  'The data quality check on your dashboard reports the real effect from live traffic.';

/**
 * Findings for a game client created outside the game, for the javascript
 * engine only. ctx = { engine, files, read, includeTests, includeDocs }.
 */
export function webGateFindings({ engine, files, read, includeTests = false, includeDocs = false }) {
  if (engine !== 'javascript') return [];
  const inScope = (rel) => callScopeExclusion(rel, { includeTests, includeDocs }) === null;
  if (!siteSignal(files, read, inScope)) return [];

  // Every scanned browser script, prepared once.
  const scripts = [];
  for (const f of files) {
    if (!SCRIPT_EXTS.has(extOf(f.rel)) || !inScope(f.rel) || SERVER_PATH_RE.test(f.rel)) continue;
    const text = read(f.rel);
    if (text == null || NODE_IMPORT_RE.test(text)) continue;
    const stripped = scriptOnly(stripComments(text, f.rel), f.rel);
    scripts.push({ rel: f.rel, kind: fileKind(f.rel), text: stripped, code: blankStrings(stripped) });
  }
  const everyPage = scripts.filter((s) => s.kind !== 'module');

  const out = [];
  for (const s of scripts) {
    if (!/ravensight/i.test(s.text)) continue;
    const names = clientNames(s.text);
    let ranges = null;
    for (const m of s.code.matchAll(/\bnew\s+(?:window\.|globalThis\.)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!names.has(m[1])) continue;
      ranges = ranges || functionRanges(s.code);
      const index = m.index;
      const line = lineOf(s.code, index);
      const where = `${s.rel}:${line}`;
      const enclosing = ranges.filter((r) => inside(r, index));
      let title = null;
      let detail = null;
      if (enclosing.length === 0) {
        if (s.kind === 'public') {
          title = 'The game SDK starts on a public page, not inside the game';
          detail = `${where} creates the game client on a page whose name says it is public (${normalizedBase(s.rel)}).`;
        } else if (s.kind === 'module') {
          title = 'The game SDK starts when the app loads, not inside the game';
          detail = `${where} creates the game client as soon as the module is first imported, which in a single page app is usually at app start.`;
        } else {
          title = 'The game SDK starts when the app loads, not inside the game';
          detail = `${where} creates the game client in ${s.kind === 'root' ? 'a component on every page' : 'the app\'s entry'}, so it runs when the app loads.`;
        }
      } else {
        const named = enclosing.filter((r) => r.name).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
        if (!named) continue; // an anonymous callback with no name to follow
        const headers = new Set(ranges.map((r) => r.at));
        const parent = callersOf(s.code, ranges, headers, named);
        // A path from a caller down to the constructor is gated when any
        // function on it checks a route or a sign in.
        const pathGated = (name) => {
          for (let at = name; at; at = parent.get(at)) {
            const r = ranges.find((range) => range.name === at);
            if (r && gated(s.code, r.start, r.end)) return true;
          }
          return false;
        };
        const lineGated = (code, index) => {
          const from = code.lastIndexOf('\n', code.lastIndexOf('\n', index - 1) - 1) + 1;
          return gated(code, from, code.indexOf('\n', index) === -1 ? code.length : code.indexOf('\n', index));
        };
        let caller = null;
        for (const name of parent.keys()) {
          if (pathGated(name)) continue;
          const own = callsAt(s.code, name, headers).find((i) => !ranges.some((r) => inside(r, i)) && !lineGated(s.code, i));
          if (own !== undefined) {
            caller = { rel: s.rel, line: lineOf(s.code, own), name };
            break;
          }
          for (const page of everyPage) {
            if (page.rel === s.rel || !importsModule(page.text, s.rel)) continue;
            page.headers = page.headers || new Set(functionRanges(page.code).map((r) => r.at));
            const at = callsAt(page.code, name, page.headers).find((i) => !lineGated(page.code, i));
            if (at !== undefined) {
              caller = { rel: page.rel, line: lineOf(page.code, at), name };
              break;
            }
          }
          if (caller) break;
        }
        if (!caller) continue;
        title = 'The game SDK starts when the app loads, not inside the game';
        detail = `${where} creates the game client in ${named.name}, and ${caller.rel}:${caller.line} calls ${caller.name}, ` +
          'which runs when the app loads or on a public page.';
      }
      out.push(finding(ID, 'warning', title, detail + ADVICE, s.rel, line));
      if (out.length >= MAX_FINDINGS) return out;
    }
  }
  return out;
}
