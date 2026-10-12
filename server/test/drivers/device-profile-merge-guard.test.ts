// A truncated device-cache list must not win the profile merge.
//
// PART OF THE 2026-10-12 CACHE-INCIDENT CLASS. The on-connect self-describe walk produces lists that
// are truncated BY CONSTRUCTION: the live label walk ends at the first empty/timeout reply
// (forgefx-midi/src/cache/liveWalk.ts) and a read-only walk stops at param 127
// (services/deviceCache.ts WALK_MAX_PARAM_ID). Before this round `runtimeProfileFrom` merged those
// lists with `builtEnums[family]?.[pid] ?? staticProfile.enumLabelsFor(...)` — `??` falls through only
// on `undefined`, so a SHORTER cache list silently won over the longer static one. Downstream the enum
// decode is `tv = raw > max ? round(raw/65534*max) : raw` with `max` derived from the list length
// (drivers/gen3.ts), so one walk timeout can decode an amp type as model 0. The roster path had the
// same shape (a cache roster with fewer entries replaced the static one).
//
// The rule now enforced: a cache list REPLACES the static one only when it is at least as LONG.
//
// Mocked transport not needed (this is a pure merge over the static FM3 profile); no hardware.
import { PROFILES, runtimeProfileFrom, SLUG_FAMILY } from '../../src/devices.js';
import { assert, assertEqual } from '../helpers/mock.js';
import type { BuiltCache } from 'forgefx-midi/cache';

const MODEL = 0x11; // FM3

/** A minimal BuiltCache carrying only the overrides a case supplies. */
function cacheWith(parts: Partial<Pick<BuiltCache, 'enumOverrides' | 'rosters'>>): BuiltCache {
  return {
    model: MODEL,
    firmware: '13.0',
    ranges: {},
    rangeSections: {},
    enumOverrides: parts.enumOverrides ?? {},
    rosters: parts.rosters ?? {},
    cabIrs: {},
    unmappedSections: [],
    unmappedFamilies: [],
    meta: { recordCount: 0, source: 'live', builtAt: '2026-10-12T19:50:18.387Z' }
  } as unknown as BuiltCache;
}

/** Find a (family, paramId) whose STATIC FM3 enum list is non-trivial, so a case cannot be vacuous. */
function findStaticEnum(): { family: string; paramId: number; labels: string[] } {
  const prof = PROFILES[MODEL]!;
  for (const [family, defs] of Object.entries(prof.params)) {
    for (const p of defs) {
      const labels = prof.enumLabelsFor(family, p.paramId);
      if (labels && labels.length >= 3) return { family, paramId: p.paramId, labels };
    }
  }
  throw new Error('no static FM3 enum list with >= 3 labels — the merge-guard test cannot run');
}

export const DEVICE_PROFILE_MERGE_GUARD_CASE_COUNT = 3;

export async function runDeviceProfileMergeGuardTests(): Promise<void> {
  const prof = PROFILES[MODEL]!;

  // ── 1. A TRUNCATED cache enum list LOSES to the static list; a cache list of the SAME length still
  //    wins (so the guard is a length test, not a "always ignore the cache" stub). FAILS BEFORE: the
  //    truncated list won via `??`. ──
  {
    const { family, paramId, labels } = findStaticEnum();
    const truncated = cacheWith({ enumOverrides: { [family]: { [String(paramId)]: labels.slice(0, 1) } } });
    const mergedTrunc = runtimeProfileFrom(truncated, prof);
    const gotTrunc = mergedTrunc.enumLabelsFor(family, paramId);
    assertEqual(gotTrunc?.length, labels.length,
      `case 1: a truncated cache enum list (1 of ${labels.length}) must lose to the static list for ${family}/${paramId}`);
    assert(gotTrunc!.every((l, i) => l === labels[i]), 'case 1: the static list is returned verbatim, not a reshaped cache list');

    const equal = labels.map((l) => `CACHE ${l}`); // same length, different content
    const full = cacheWith({ enumOverrides: { [family]: { [String(paramId)]: equal } } });
    const mergedFull = runtimeProfileFrom(full, prof);
    const gotFull = mergedFull.enumLabelsFor(family, paramId);
    assertEqual(gotFull?.length, labels.length, 'case 1 (control): a cache enum list of the same length is accepted');
    assertEqual(gotFull![0], equal[0], 'case 1 (control): a complete cache list still wins — the guard is a LENGTH test, not a blanket refusal');
  }

  // ── 2. A TRUNCATED cache ROSTER LOSES to the static roster. FAILS BEFORE: the shorter roster replaced
  //    the static one, shifting every model ordinal. ──
  {
    const slug = 'amp'; // DISTORT — a large device-true model list
    const fam = SLUG_FAMILY[slug]!;
    const staticRoster = prof.rosterFor(slug);
    assert(staticRoster.length >= 3, `case 2 (control): the static ${slug} roster is non-trivial (${staticRoster.length})`);
    const truncated = staticRoster.slice(0, 2);
    const merged = runtimeProfileFrom(cacheWith({ rosters: { [fam]: truncated } }), prof);
    const got = merged.rosterFor(slug);
    assertEqual(got.length, staticRoster.length,
      `case 2: a truncated cache roster (2 of ${staticRoster.length}) must lose to the static ${slug} roster`);
    assertEqual(got[staticRoster.length - 1]!.name, staticRoster[staticRoster.length - 1]!.name,
      'case 2: the FULL static roster is returned (its last model is present — no silent truncation)');
  }

  // ── 3. No over-rejection: a cache roster that is NOT shorter still replaces the static one (names come
  //    from the cache, lineage overlaid from static). ──
  {
    const slug = 'amp';
    const fam = SLUG_FAMILY[slug]!;
    const staticRoster = prof.rosterFor(slug);
    const fullCache = staticRoster.map((t) => ({ ...t, name: `CACHE ${t.name}` }));
    const merged = runtimeProfileFrom(cacheWith({ rosters: { [fam]: fullCache } }), prof);
    const got = merged.rosterFor(slug);
    assertEqual(got.length, staticRoster.length, 'case 3 (control): a complete cache roster keeps the static length');
    assertEqual(got[0]!.name, fullCache[0]!.name, 'case 3 (control): a complete cache roster still wins (device-true names)');
    assertEqual(got[0]!.manufacturer, staticRoster[0]!.manufacturer, 'case 3 (control): static lineage is still overlaid on the cache names');
  }
}
