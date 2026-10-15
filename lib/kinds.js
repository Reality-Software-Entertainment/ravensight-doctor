// The platform's event name heuristics, for name_without_kind.
//
// Copied from the Ravensight platform, src/services/eventKinds.js at commit
// d00fe78 (LEVEL_START_PATTERN, LEVEL_COMPLETE_PATTERN, DEATH_PATTERN). The
// platform matches them unanchored and case sensitive against the event
// name, and an explicit rs_kind (level_start, level_complete, death or none)
// decides first. Keep these in step with that file.

export const KIND_KEY = 'rs_kind';

export const NAME_KINDS = [
  { kind: 'level_start', label: 'a level start', pattern: 'start|begin|enter' },
  { kind: 'level_complete', label: 'a level completion', pattern: 'complet|finish|win|clear' },
  { kind: 'death', label: 'a death', pattern: 'died|destroyed|killed' },
].map((k) => ({ ...k, re: new RegExp(k.pattern) }));

/**
 * What the platform reads an event name as when the event carries no
 * rs_kind: { kind, label, word } for the first pattern that matches, or
 * null.
 */
export function kindByName(name) {
  for (const k of NAME_KINDS) {
    const m = k.re.exec(String(name));
    if (m) return { kind: k.kind, label: k.label, word: m[0] };
  }
  return null;
}
