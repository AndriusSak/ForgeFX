// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-1b-structure — what `fn=0x01 sub=0x1b` (request byte 7 = 0x00) answers PER EID.
//
// WHY THIS ONE FIRST. ROUND 12 left `0x1b` as the only sub-action here with a STABLE reply: reproducible
// per eid, byte-identical across 5 reads per stage × 3 stages, and untouched by a bypass write. Everything
// else in this area drifts. Upstream's capture-derived name for it is PARAM FLAGS and the reply is 14 data
// bytes `00 <eid> 00 00 00 <b5> <b6> <b7> 00 00 00 00 00 00`, so only three bytes carry content.
//
// KNOWN VALUES (ROUND 12, preset "USA Mk IV", 15 eids): `0x2a/0x2b/0x36/0x32 → 7f 7f 01`, `0x25 → 66 4c 01`,
// `0x46 → 47 42 00`, `0x4e → 0c 00 00`, `0x5a → 05 00 00`, `0x76 → 0e 00 00`, `0x42 → 02 00 00`,
// `0x5e → 01 00 00`, `0x3a/0x3e → 00 00 00`. Note `0x2a`/`0x2b` are PLACED yet read the same as the two
// UNPLACED eids — that coincidence is the thing this run has to explain, not step over.
//
// HYPOTHESES AND THEIR PREDICTIONS — written BEFORE any frame was sent. Each predicts DIFFERENT values for
// the rows about to be read (the whole eid range, not a curated list):
//
//   H_A FAMILY CAPABILITY. The bytes describe what the block TYPE can do. PREDICTS: eids of one family all
//       answer the SAME triple, and different families differ. A family whose instances disagree refutes it.
//   H_B PER-INSTANCE STATE. The bytes describe this block's own configuration. PREDICTS: eids of one family
//       answer DIFFERENT triples (when their configuration differs), and a family with one instance cannot
//       distinguish H_A from H_B at all — that is a limitation of this run, stated rather than hidden.
//   H_C ABSENT-BLOCK DEFAULT. Unplaced eids all answer one fixed triple that is not meaningful. PREDICTS:
//       every unplaced eid shares one value (we already have two: `7f 7f 01`), and placed eids may share it
//       too by coincidence.
//   H_D PARAM-COUNT CODEC. The triple is a count or a mask sized to the block's parameter count. PREDICTS:
//       the set-bit count (or the packed value) orders with the family's parameter count. A family with more
//       than 21 parameters cannot be represented at all, so this predicts a CAP.
//
// The instrument is validated in-run: sub 0x99 (never answered) must come back SILENT, and one eid is read
// twice and must answer identically (the stability ROUND 12 measured, re-observed here).
//
// READ-ONLY. Every frame is a read-shaped `fn=0x01` with no value bytes. A tap is written when FORGEFX_TAP is set.
//
// USAGE  npx tsx scripts/probe-1b-structure.ts [--port /dev/ttyACM0] [--from 0x20] [--to 0x7f]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { slugForEffectId } from 'forgefx-midi/devices/gen3';
import { PROFILES, SLUG_FAMILY } from '../src/devices.js';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function subQuery(sub: number, at: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, ...at];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}
const dataOf = (frames: readonly number[][], sub: number): number[] | null => {
  const f = frames.find((x) => x[5] === 0x01 && x[6] === sub && x.length <= 100 && x.length > 10);
  return f ? f.slice(7, -1) : null;
};
/** The three content bytes at data offsets 5..7, as a number and as a bit count. */
const tripleOf = (d: readonly number[]) => [d[5] ?? 0, d[6] ?? 0, d[7] ?? 0];
const bitsSet = (t: readonly number[]) => t.reduce((n, b) => n + b.toString(2).split('').filter((x) => x === '1').length, 0);
/** The packed value as three 7-bit septets (the codec's own packing order: first byte = lowest septet). */
const pack3 = (t: readonly number[]) => t[0]! + t[1]! * 128 + t[2]! * 16384;

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const from = Number(arg('--from') ?? 0x20);
  const to = Number(arg('--to') ?? 0x7f);
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    console.log(`device ${session.label} · READ-ONLY · sub 0x1b sweep eid 0x${from.toString(16)}..0x${to.toString(16)}`);
    console.log('predictions (written before any frame was sent):');
    console.log('  H_A family capability: same family ⇒ same triple, different families differ');
    console.log('  H_B per-instance state: same family ⇒ different triples when configurations differ');
    console.log('  H_C absent default: every unplaced eid shares one (meaningless) triple');
    console.log('  H_D param-count codec: set-bit count or packed value orders with the family param count (capped at 21)');

    const state = (await session.driver.sceneState?.()) ?? [];
    const placed = new Set(state.map((s) => s.effectId));
    console.log(`fn=0x13 placed: ${[...placed].sort((a, b) => a - b).map((e) => '0x' + e.toString(16)).join(' ')}`);

    const neg = await session.transport.request(subQuery(0x99, [0x00, 0x2a, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 });
    console.log(`negative control 0x99 → ${neg.filter((f) => f[5] === 0x01 && f[6] === 0x99).length ? 'ANSWERED (unexpected)' : 'SILENT'}`);

    const params = PROFILES[MODEL]!.params as unknown as Record<string, { name: string }[]>;

    const read = async (eid: number): Promise<number[] | null> =>
      dataOf(await session.transport.request(subQuery(0x1b, [0x00, eid, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 }), 0x1b);

    // Stability re-observation (the positive control for "this channel is readable at all").
    const s1 = hex(tripleOf((await read(0x2a)) ?? []));
    const s2 = hex(tripleOf((await read(0x2a)) ?? []));
    console.log(`stability control eid 0x2a read twice: ${s1} vs ${s2} → ${s1 === s2 ? 'IDENTICAL' : 'DIFFERENT'}\n`);

    console.log('  eid   slug            family        placed  b5 b6 b7   bits  pack3   params');
    const rows: Array<{ eid: number; slug: string; family: string; placed: boolean; triple: number[] }> = [];
    for (let eid = from; eid <= to; eid++) {
      const d = await read(eid);
      await sleep(20);
      if (!d) { console.log(`  0x${eid.toString(16).padStart(2, '0')}   (silent)`); continue; }
      const t = tripleOf(d);
      const slug = slugForEffectId(eid) ?? '';
      const family = SLUG_FAMILY[slug.toLowerCase()] ?? '';
      const np = family ? (params[family]?.length ?? 0) : 0;
      rows.push({ eid, slug, family, placed: placed.has(eid), triple: t });
      console.log(`  0x${eid.toString(16).padStart(2, '0')}   ${slug.padEnd(15)} ${family.padEnd(13)} ${String(placed.has(eid)).padEnd(6)}  ${hex(t)}   ${String(bitsSet(t)).padStart(4)}  ${String(pack3(t)).padStart(5)}   ${np || '-'}`);
    }

    // ── the two comparisons the hypotheses are actually about ─────────────────────────────────────
    console.log('\n  by FAMILY — does one family answer one triple? (H_A)');
    const byFam = new Map<string, Map<string, number[]>>();
    for (const r of rows) {
      if (!r.family) continue;
      const m = byFam.get(r.family) ?? new Map<string, number[]>();
      m.set(hex(r.triple), [...(m.get(hex(r.triple)) ?? []), r.eid]);
      byFam.set(r.family, m);
    }
    for (const [fam, m] of [...byFam].sort((a, b) => a[0].localeCompare(b[0]))) {
      const parts = [...m].map(([v, eids]) => `${v}(×${eids.length}: ${eids.map((e) => '0x' + e.toString(16)).join(',')})`);
      console.log(`    ${fam.padEnd(13)} ${m.size === 1 ? 'ONE value' : `${m.size} values`}  ${parts.join('  ')}`);
    }

    console.log('\n  by VALUE — which eids share a triple? (H_C predicts the unplaced ones collapse)');
    const byVal = new Map<string, number[]>();
    for (const r of rows) byVal.set(hex(r.triple), [...(byVal.get(hex(r.triple)) ?? []), r.eid]);
    for (const [v, eids] of [...byVal].sort((a, b) => b[1].length - a[1].length)) {
      const unplaced = eids.filter((e) => !placed.has(e)).length;
      console.log(`    ${v}  ×${eids.length} (${unplaced} unplaced)  ${eids.map((e) => '0x' + e.toString(16)).join(' ')}`);
    }
    // ── INDEX SWEEP: the reply ECHOES all five address bytes at data[0..4], so bytes 9..11 are selectors ──
    //
    // The full-eid sweep used a zeroed address tail. If the three content bytes are ONE PAGE of a larger set,
    // some address byte must select the page — and that is testable read-only, before any write is spent.
    // PREDICTION, written before this loop: H_paged says the content CHANGES with the swept byte and the pages
    // differ from each other; H_noindex says the content is byte-identical for every value.
    const idxEid = arg('--index-sweep') !== undefined ? parseInt(arg('--index-sweep')!, 16) : undefined;
    if (idxEid !== undefined && arg('--pos') !== undefined) {
      // COMPACT single-byte sweep, for the discriminator: is the selector's table GLOBAL (the same for every
      // eid) or JOINT with the eid? PREDICTION, before the run: if (eid A, k) == (eid B, k) for every k, the
      // selector alone carries the content and the eid byte only matters at k = 0; any k where they differ
      // refutes that. Printed grouped by value so the comparison is a diff of two short maps, not 128 lines.
      const pos = Number(arg('--pos'));
      const to = Number(arg('--to') ?? 0x7f);
      const byVal = new Map<string, number[]>();
      for (let v = 0; v <= to; v++) {
        const at = [0x00, idxEid, 0x00, 0x00, 0x00];
        at[pos] = v;
        const d = dataOf(await session.transport.request(subQuery(0x1b, at), { timeoutMs: 900, quietMs: 60 }), 0x1b);
        const t = d ? hex(tripleOf(d)) : '(silent)';
        byVal.set(t, [...(byVal.get(t) ?? []), v]);
      }
      console.log(`\n  at[${pos}] sweep on eid 0x${idxEid.toString(16)}, 0x00..0x${to.toString(16)} → ${byVal.size} distinct value(s)`);
      for (const [val, vs] of [...byVal].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`    ${val}  at[${pos}] ∈ {${vs.map((v) => '0x' + v.toString(16).padStart(2, '0')).join(',')}}`);
      }
      return 0;
    }
    if (idxEid !== undefined) {
      for (const pos of [2, 3, 4]) {
        console.log(`\n  index sweep on eid 0x${idxEid.toString(16)}: address byte ${7 + pos} (= at[${pos}]) over 0..15`);
        const seen: string[] = [];
        for (let v = 0; v <= 15; v++) {
          const at = [0x00, idxEid, 0x00, 0x00, 0x00];
          at[pos] = v;
          const d = dataOf(await session.transport.request(subQuery(0x1b, at), { timeoutMs: 900, quietMs: 60 }), 0x1b);
          const t = d ? hex(tripleOf(d)) : '(silent)';
          seen.push(t);
          console.log(`    at[${pos}]=${v.toString(16).padStart(2, '0')} → ${t}${d ? `   (data[0..7] = ${hex(d.slice(0, 8))})` : ''}`);
        }
        console.log(`    ⇒ ${new Set(seen).size === 1 ? `CONSTANT (${seen[0]}) — this byte does NOT page the content` : `${new Set(seen).size} distinct values — this byte CHANGES the content`}`);
      }
      return 0;
    }

    console.log('\nNOTHING HERE IS DECODED. These are values and groupings; the reading is the next step.');
    return 0;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
