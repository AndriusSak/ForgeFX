// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-1b-fixed-records — ROUND 14, task 1. The two FIXED records `0x1b` answers for a non-zero
// address selector, and whether `0x2e` (which has its own byte-7 selector) exposes the same ones.
//
// MEASURED ALREADY (ROUND 13, `test/fixtures/query-subs-decode/1b-address-selectors.tap`): with the reply's
// address echo at data 0-4 and content at data 5-7,
//   * at[2] (address byte 9) ≠ 0  → content `01 00 00`, for every value 1..15 tested;
//   * at[4] (address byte 11) ≠ 0 → content `1b 14 4c`, for every value 1..15 tested.
// A selector that ignores its own VALUE is a MODE, not an index — that is the reading this run tests.
//
// HYPOTHESES AND THEIR PREDICTIONS — written BEFORE any frame is sent. Each predicts DIFFERENT content for
// the exact rows this run sets:
//
//   H_MODE  (device-level mode records). The selector picks one of a small fixed set of device-level
//       records, independent of everything else in the address.
//       PREDICTS: (a) at[1] (the "eid" byte) swept 0x00..0x3f with at[2]=1 gives `01 00 00` for EVERY
//       value — the record does NOT move with the eid; the same for at[4]=1 → `1b 14 4c`.
//       (b) `0x2e`'s byte-7 selector exposes the SAME records somewhere in its reply (a shared mode set).
//   H_ADDR  (the record is addressed by the rest of the region). The selector gates a mode, but the content
//       still varies with the address.
//       PREDICTS: (a) the content CHANGES with at[1] (at least two distinct triples over 0x00..0x3f);
//       (b) `0x2e` exposes its own set, NOT the two values above.
//   H_MIXED (partial): exactly one of the two records moves with at[1]. Kept because the two selectors are
//       independent bytes and there is no prior reason they behave identically; a single verdict for both
//       would hide that.
//
// RESULT (measured 2026-10-12, FM3 fw 13.0, preset "USA Mk IV" — full run log in
// `review-2026-10-12/probe-1b-fixed-records.out`, tap `test/fixtures/query-subs-decode/1b-fixed-records.tap`):
//
//   1. THE CONTENT IS NINE BYTES, NOT THREE. ROUND 13's "content is the three bytes at data 5-7, data 8-13 are
//      zero" is TRUE only for the zeroed address tail. Every selector reply carries `1b 14 4c 7a 0a` at
//      data 5-9. ROUND 13's own tool printed `data[0..7]` in its selector mode, so it never saw them.
//   2. NEITHER RECORD IS A DEVICE CONSTANT (H_MODE(a) REFUTED, H_ADDR supported). With the selector fixed at
//      1 the content still moves with at[1]: 8 distinct values over 0x00..0x3f with at[2]=1, 4-6 with at[4]=1.
//   3. `byte 9 ≠ 0` IS NOT `01 00 00`. ROUND 13 recorded that value at 13:57; the SAME tool with a
//      BYTE-IDENTICAL TX sequence answered `1b 14 4c 7a 0a 02` at 14:26 and again at 14:50, same preset, same
//      placed set. The value byte 9 returns is byte-identical to what the 49 UNUSED eids return with a zeroed
//      tail — so byte 9 selects the DEFAULT/hole record, and that record is what moved (see the README).
//   4. `byte 11 ≠ 0` DID reproduce byte-for-byte: `1b 14 4c 7a 0a 00`.
//   5. `0x2e` EXPOSES THE SAME HEAD (H_MODE(b) SUPPORTED): request byte 7 ∈ 1..15 answers a 23-byte reply whose
//      data 5-9 are `1b 14 4c 7a 0a` with trailer 00 — byte-identical to `0x1b[at4≠0]` on eid 0x46 in the same
//      session, and 0x2e's byte-7 selector ignores its own value across 1..15 (a MODE, not an index). The long
//      `0x2e` (byte 7 = 0) does NOT contain that run anywhere in its 590 bytes.
//   6. NOT the same function of the eid through both doors: 0x2e[sel=1] and 0x1b[at4=1] agree exactly on eid
//      0x46 but only 16/64 over 0x00..0x3f. Cross-check that does hold: 0x2e[sel=1]'s 16 `…02` eids are
//      EXACTLY the 16 eids whose zeroed-tail 0x1b record is the default.
//
// The instrument is validated in-run: sub 0x99 (never answered) must come back SILENT, and eid 0x46 read
// twice at a zeroed address must answer identically (the ROUND 12/13 stability control, re-observed).
//
// NB on the `0x2e` half: `01 00 00` is a common byte run and can occur by chance in a 590-byte reply, so its
// presence there is reported with its occurrence count and offsets, never as a hit by itself. `1b 14 4c` is
// distinctive enough to be worth its own line, and the script also reports the chance expectation.
//
// READ-ONLY. Every frame is a read-shaped `fn=0x01` with no value bytes. A frame tap is written (FORGEFX_TAP
// is named explicitly by the runner when the evidence is to be cited).
//
// USAGE  npx tsx scripts/probe-1b-fixed-records.ts [--port /dev/ttyACM0] [--to 0x3f]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `fn=0x01` read frame with the sub-action and the 5-byte address region (byte7 = sel, byte8 = eid). */
function subQuery(sub: number, at: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, ...at];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}
const payload = (frames: readonly number[][], sub: number, long: boolean): number[] | null => {
  const f = frames.find((x) => x[5] === 0x01 && x[6] === sub && (long ? x.length > 100 : x.length <= 100 && x.length > 10));
  return f ? f.slice(7, -1) : null;
};
/** Content bytes at data offsets 5..7 (the 21 bits), as the established reply shape puts them. */
const tripleOf = (d: readonly number[]) => [d[5] ?? -1, d[6] ?? -1, d[7] ?? -1];

/** fn=0x0D QUERY PATCH NAME — the cheapest "which preset is this" provenance oracle. */
function patchNameQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x0d, 0x7f, 0x7f];
  return [...body, fractalChecksum(body), 0xf7];
}
function patchNameOf(frames: readonly number[][]): string {
  const f = frames.find((x) => x[5] === 0x0d);
  if (!f) return '<no reply>';
  return String.fromCharCode(...f.slice(6, -2).filter((b) => b >= 0x20 && b < 0x7f)).trim();
}

/** Every offset at which `pat` occurs in `hay`, so a common run is reported as a count, not a hit. */
function occurrences(hay: readonly number[], pat: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + pat.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) if (hay[i + j] !== pat[j]) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const to = Number(arg('--to') ?? 0x3f);
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    console.log(`device ${session.label} · READ-ONLY · ROUND 14 task 1 (the two fixed 0x1b records)`);
    console.log('predictions (written before any frame was sent):');
    console.log('  H_MODE  the selector picks a device-level record: (a) content constant across at[1] 0x00..0x' + to.toString(16) + ',');
    console.log('          (b) 0x2e exposes the same two records.');
    console.log('  H_ADDR  the content still moves with at[1]; 0x2e exposes its own, different set.');
    console.log('  H_MIXED exactly one of the two selectors moves with at[1].');

    const state = (await session.driver.sceneState?.()) ?? [];
    const placed = state.map((s) => s.effectId).sort((a, b) => a - b);
    console.log(`\npreset in the edit buffer (fn=0x0d): "${patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }))}"`);
    console.log(`fn=0x13 placed (context): ${placed.map((e) => '0x' + e.toString(16)).join(' ')}`);

    // ── instrument validation ─────────────────────────────────────────────────────────────────────
    const neg = (await session.transport.request(subQuery(0x99, [0x00, 0x46, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 }))
      .filter((f) => f[5] === 0x01 && f[6] === 0x99);
    console.log(`negative control sub 0x99 → ${neg.length ? 'ANSWERED (unexpected)' : 'SILENT'}`);

    const read1b = async (at: readonly number[]): Promise<number[] | null> =>
      payload(await session.transport.request(subQuery(0x1b, at), { timeoutMs: 900, quietMs: 60 }), 0x1b, false);

    const s1 = hex(tripleOf((await read1b([0x00, 0x46, 0, 0, 0])) ?? []));
    const s2 = hex(tripleOf((await read1b([0x00, 0x46, 0, 0, 0])) ?? []));
    console.log(`stability control eid 0x46 read twice: ${s1} vs ${s2} → ${s1 === s2 ? 'IDENTICAL' : 'DIFFERENT'}`);

    // ── re-observe the two fixed records over the selector's own value range ──────────────────────
    console.log('\nre-observation — the selector value itself should not matter (H_MODE):');
    const selContent: Record<number, string> = {};
    for (const [label, pos] of [['at[2] (byte 9)', 2], ['at[4] (byte 11)', 4]] as const) {
      const seen = new Map<string, number[]>();
      const full = new Map<string, number[]>();
      for (let v = 1; v <= 15; v++) {
        const at = [0x00, 0x46, 0, 0, 0]; at[pos] = v;
        const d = (await read1b(at)) ?? [];
        const t = hex(tripleOf(d));
        seen.set(t, [...(seen.get(t) ?? []), v]);
        full.set(hex(d.slice(5, 14)), [...(full.get(hex(d.slice(5, 14))) ?? []), v]);
      }
      selContent[pos] = [...full.keys()][0] ?? '(silent)';
      console.log(`  ${label}: ${seen.size} distinct value(s) — ${[...seen].map(([t, vs]) => `${t}(v=${vs.join(',')})`).join('  ')}`);
      console.log(`     full content (data 5..13): ${selContent[pos]}`);
    }

    // The ROUND 13 claim, checked against this run EVERY time so the correction cannot quietly return.
    // It is printed even when it agrees: a reader must not have to diff two rounds to know the state.
    console.log('\nROUND 13 CLAIM CHECK (byte 9 ≠ 0 → `01 00 00`, byte 11 ≠ 0 → `1b 14 4c`, eid 0x46):');
    console.log(`  byte  9 ≠ 0: ROUND 13 recorded \`01 00 00\`; this run: ${selContent[2]}`);
    console.log(`     ⇒ ${selContent[2].startsWith('01 00 00') ? 'agrees with ROUND 13' : 'DIFFERS — that value is NOT a device constant (see the README ROUND 14 section): the same tool with a byte-identical TX sequence answered `01 00 00 00 00 02 00 00 00` at 13:57 and `1b 14 4c 7a 0a 02 00 00 00` at 14:26 on the same preset.'}`);
    console.log(`  byte 11 ≠ 0: ROUND 13 recorded \`1b 14 4c\`; this run: ${selContent[4]}`);
    console.log(`     ⇒ ${selContent[4].startsWith('1b 14 4c') ? 'reproduced' : 'DIFFERS — do not publish a fixed value'}`);

    // ── (a) does the fixed record change with at[1] (the "eid" byte)? ──────────────────────────────
    console.log(`\n(a) at[1] swept 0x00..0x${to.toString(16)}, selector fixed. H_MODE predicts ONE value per selector.`);
    const distinctByPos: Record<number, number> = {};
    for (const [label, pos] of [['at[2]=0x01 (byte 9)', 2], ['at[4]=0x01 (byte 11)', 4]] as const) {
      const seen = new Map<string, number[]>();
      for (let e = 0; e <= to; e++) {
        const at = [0x00, e, 0, 0, 0]; at[pos] = 0x01;
        const d = await read1b(at);
        await sleep(15);
        const t = d ? hex(tripleOf(d)) : '(silent)';
        seen.set(t, [...(seen.get(t) ?? []), e]);
      }
      distinctByPos[pos] = seen.size;
      console.log(`  ${label}  ${seen.size} distinct —`);
      for (const [t, es] of [...seen].sort((a, b) => b[1].length - a[1].length)) {
        const list = es.map((e) => '0x' + e.toString(16).padStart(2, '0')).join(',');
        console.log(`    ${t}  ×${es.length}  at[1] ∈ {${es.length > 16 ? list.slice(0, 80) + '…' : list}}`);
      }
    }
    console.log(`  ⇒ H_MODE(a) ${distinctByPos[2] === 1 && distinctByPos[4] === 1 ? 'SUPPORTED (both selectors give one value each)' : `REFUTED — the content moves with at[1] (${distinctByPos[2]} distinct under byte 9, ${distinctByPos[4]} under byte 11)`}`);

    // ── (b) does 0x2e expose the same two records? ────────────────────────────────────────────────
    console.log('\n(b) 0x2e replies, byte-7 selector swept 0x00..0x0f — does either record appear?');
    const PAT_B = [0x1b, 0x14, 0x4c];   // the ONLY distinctive 3-byte run: `01 00 00` is common in this region
    for (let sel = 0; sel <= 0x0f; sel++) {
      const heard = await session.transport.request(subQuery(0x2e, [sel, 0x46, 0, 0, 0]), { timeoutMs: 1200, quietMs: 90 });
      const long = heard.find((f) => f[5] === 0x01 && f[6] === 0x2e && f.length > 100) ?? null;
      const short = heard.find((f) => f[5] === 0x01 && f[6] === 0x2e && f.length <= 100 && f.length > 10) ?? null;
      if (!long && !short) { console.log(`  sel=0x${sel.toString(16)}: (no 0x2e reply)`); continue; }
      if (long) {
        const d = long.slice(7, -1);
        console.log(`  sel=0x${sel.toString(16)} long  ${String(long.length).padStart(4)}B  data[0..7]=${hex(d.slice(0, 8))}  '1b 14 4c' ×${occurrences(d, PAT_B).length}`);
      }
      if (short) {
        const d = short.slice(7, -1);
        console.log(`  sel=0x${sel.toString(16)} short ${String(short.length).padStart(4)}B  data[0..13]=${hex(d.slice(0, 14))}`);
      }
      await sleep(20);
    }

    // ── (c) is the 0x2e short reply the SAME function of the eid as 0x1b at[4]≠0? ────────────────
    // The two subs answer byte-identical content at data 5-9 for eid 0x46. If the whole eid sweep agrees,
    // the record is SHARED (one table read through two doors) rather than two lookalike records. PREDICTION,
    // written before the run: SHARED predicts 0 mismatches over the sweep; two-lookalike-records predicts
    // mismatches at the eids where their tables differ.
    console.log(`\n(c) 0x2e[sel=1] vs 0x1b[at4=1], eid 0x00..0x${to.toString(16)}, content data[5..13]:`);
    let mism = 0;
    const rows: Array<[number, string, string]> = [];
    for (let e = 0; e <= to; e++) {
      const heard = await session.transport.request(subQuery(0x2e, [0x01, e, 0, 0, 0]), { timeoutMs: 1200, quietMs: 90 });
      const sh = heard.find((f) => f[5] === 0x01 && f[6] === 0x2e && f.length <= 100 && f.length > 10) ?? null;
      const a = sh ? hex(sh.slice(7, -1).slice(5, 14)) : '(silent)';
      const d1b = await read1b([0x00, e, 0, 0, 0x01]);
      const b = d1b ? hex(d1b.slice(5, 14)) : '(silent)';
      if (a !== b) mism++;
      rows.push([e, a, b]);
      await sleep(12);
    }
    const shown = rows.filter(([, a, b]) => a !== b).slice(0, 24);
    console.log(`  mismatches: ${mism}/${rows.length}  → ${mism === 0 ? 'SHARED (one table, two doors)' : 'NOT the same function of the eid'}`);
    for (const [e, a, b] of shown) console.log(`    0x${e.toString(16).padStart(2, '0')}  0x2e[1] ${a}   vs   0x1b[at4] ${b}`);
    const uniq = new Map<string, number[]>();
    for (const [e, a] of rows) uniq.set(a, [...(uniq.get(a) ?? []), e]);
    console.log(`  0x2e[sel=1] distinct content over the sweep: ${uniq.size}`);
    for (const [v, es] of [...uniq].sort((x, y) => y[1].length - x[1].length)) {
      console.log(`    ${v}  ×${es.length}  ${es.length > 20 ? '' : es.map((e) => '0x' + e.toString(16).padStart(2, '0')).join(',')}`);
    }
    console.log('\nNOTHING HERE IS DECODED beyond the comparisons above; the reading is the next step.');
    return 0;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
