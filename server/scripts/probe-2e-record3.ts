// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-2e-record3 — ROUND 15b. WHAT DO HEAD RECORD #3's BYTES MEAN? Pre-registered, and DEFAULTS TO
// DRY-RUN: without `--go` it reads only and prints the plan; nothing is written.
//
// WHAT IS ALREADY MEASURED (`probe-2e-placement.ts`, ROUND 15 §3 of the fixture README): placing ONE
// not-placed instance into a verified-empty cell moves exactly ONE head record of the `fn=0x01 sub=0x2e`
// reply — #3, data 24..31 — and exactly one tail grid cell, reverting byte-identically on the clear. In all
// three arms (three different cells) the values were identical:
//
//     00 46 50 4a 55 1a 04 40   (no extra block)   →   00 4c 10 4a 55 1a 04 40   (one extra block)
//
// i.e. only data 25 and 26 move. A dwell trace showed it is STATE (held for 5 s), not a transient, and the
// same value for three different cells showed it is ONE GLOBAL field, not a per-cell table. What the value
// ENCODES was not measured. That is this script.
//
// PRE-COMMITTED HYPOTHESES AND PREDICTIONS — written BEFORE any frame is sent, and printed first, because a
// discriminator whose predictions already agree under both hypotheses is not a test:
//
//   H_FLAG   record #3 is a per-PRESET dirty/edited indicator: any structural edit sets ONE non-canonical
//            value. PREDICTS: one block = two blocks = `4c 10`; a chorus and a drive give the SAME value;
//            clearing back to zero restores `46 50`.
//   H_COUNT  record #3 carries a count (of placed blocks, of empty cells, of edits). PREDICTS: the 2-block
//            state DIFFERS from the 1-block state, but the chorus-alone and drive-alone values are the SAME
//            (a count cannot see which block it is).
//   H_HASH   record #3 is a function of the grid's CONTENT. PREDICTS: 1 block ≠ 2 blocks AND chorus-alone ≠
//            drive-alone, and every state repeats exactly when it is returned to (deterministic).
//
// THE STATE CHAIN (one session, one connection — every write self-restoring, nothing stored to any slot):
//
//   S0  baseline (no extra block)
//   S1  one block, instance A  at r1c1
//   S2  A and B, both placed    (A at r1c1, B at r1c2)
//   S3  B cleared, A still in   ← does the 1-block value RETURN? (repeatability)
//   S4  A cleared               ← canonical again? (restore proven through the body)
//   S5  one block, instance B only, at r1c1  ← id-dependence: does a different block give a different value?
//   S6  B cleared               → end state
//
// Each stage: a settle gap, then N long 0x2e replies, then a SHORT dwell (reads spread over seconds) with
// data 24..31 printed per read. The dwell is what separates state from a transient — a value that moves
// inside a dwell is not the placement's.
//
// WRITE HYGIENE. Only `placeCell(cell, eid)` and `placeCell(cell, 0)`, only into cells the dump grid says are
// EMPTY, only for instances `fn=0x13` says are NOT placed. Landing is checked through the `fn=0x13` placed set
// (a different path than the write). The restore is proved through the edit-buffer BODY (`fn=0x77/0x78/0x79`
// → decodeRawPatch), which is byte-stable across consecutive reads with nothing written. A `finally` block
// clears anything this run left placed. Exit 0 green · 2 a control or the restore failed · 3 no device ·
// 4 dry-run (nothing written — never a success).
//
// USAGE
//   npx tsx scripts/probe-2e-record3.ts            # DRY RUN: prints the plan and the predictions
//   npx tsx scripts/probe-2e-record3.ts --go       # executes (owner's go-ahead required)
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { standingRead, standingLine } from './standing-read.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { parsePresetDump, decodeRawPatch } from 'forgefx-midi/devices/gen3';

const MODEL = 0x11;
const EDIT_BUFFER = 0x3fff;
const CONTENT_BASE = 12;
/** THE RECORD UNDER TEST, in the differ's `data` space: head record #3 = data 24..31. */
const REC_LO = 24;
const REC_HI = 32;
/** Data 24 is the LAST member of the per-READ volatile trio 22/23/24 and moves on every read, so a
 *  comparison that includes it reports "not repeatable" for a value that repeats exactly. Every verdict
 *  below is computed on the record's STABLE bytes (data 25..31), and data 24 is printed but never compared. */
const VOLATILE_IN_RECORD = [24];
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const go = argv.includes('--go');
  const reads = Math.max(4, Number(arg('--reads') ?? 6));
  const dwell = Math.max(0, Number(arg('--dwell') ?? 8));
  const outdir = (arg('--outdir') ?? '/home/insn/repos/stack/review-2026-10-12/record3').replace('~', process.env.HOME ?? '');
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;

  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const problems: string[] = [];
  const placedByMe: { row: number; col: number }[] = [];
  const stageValues: Record<string, string[]> = {};
  let bodyBefore = '';
  try {
    console.log(`══ probe-2e-record3 — what does head record #3 encode? · ${go ? 'EXECUTING (--go)' : 'DRY RUN (nothing will be written)'} ══`);
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);
    console.log('\nPRE-COMMITTED PREDICTIONS (written before any frame is sent):');
    console.log('  H_FLAG  every structural edit gives ONE value     → 1 block = 2 blocks = the same, chorus = drive');
    console.log('  H_COUNT a count                                   → 2 blocks ≠ 1 block, but chorus-alone = drive-alone');
    console.log('  H_HASH  a function of the grid content            → 2 blocks ≠ 1 block AND chorus-alone ≠ drive-alone,');
    console.log('                                                       and every state repeats when it is returned to');

    const sr = await standingRead(session, { note: 'R15b record #3 semantics — start' });
    console.log(`\n${standingLine(sr)}`);
    if (sr.verdict !== 'read (controls green)') problems.push('standing read controls not green');

    const placedNow = async (): Promise<number[]> => ((await session.driver.sceneState?.()) ?? []).map((s) => s.effectId).sort((a, b) => a - b);
    const placed0 = await placedNow();
    console.log(`fn=0x13 placed (${placed0.length}): ${placed0.map((e) => '0x' + e.toString(16)).join(' ')}`);

    // ── pick TWO different not-placed instances ──
    const catalog = (session.driver.blocksCatalog?.() ?? []).filter((c) => !placed0.includes(c.page));
    const seenSlug = new Set<string>();
    const picks: { slug: string; instance: number; page: number }[] = [];
    for (const c of catalog) {
      if (seenSlug.has(c.slug)) continue;
      seenSlug.add(c.slug);
      picks.push({ slug: c.slug, instance: c.instance, page: c.page });
      if (picks.length === 2) break;
    }
    if (picks.length < 2) { console.log('need two not-placed instances with different slugs — none found.'); return 2; }
    const [A, Bs] = picks as [{ slug: string; instance: number; page: number }, { slug: string; instance: number; page: number }];
    const cellA: [number, number] = [1, 1];
    const cellB: [number, number] = [1, 2];

    // ── destination cells must be VERIFIED-EMPTY (dump grid; dump cells are 0-based → +1 for the route contract) ──
    const grid0 = await session.driver.grid();
    const occ = new Set(grid0.cells.map((c) => `${c.row + 1},${c.col + 1}`));
    for (const [r, c] of [cellA, cellB]) {
      const empty = !occ.has(`${r},${c}`);
      console.log(`  cell r${r}c${c}: ${empty ? 'VERIFIED EMPTY' : 'OCCUPIED — refusing'}`);
      if (!empty) problems.push(`destination r${r}c${c} is not empty`);
    }
    console.log(`\nPLAN (6 writes, all self-restoring, no slot written):`);
    console.log(`  S1  placeCell(${cellA.join(',')}, 0x${A.page.toString(16)})   ← ${A.slug} ${A.instance}`);
    console.log(`  S2  placeCell(${cellB.join(',')}, 0x${Bs.page.toString(16)})   ← ${Bs.slug} ${Bs.instance}`);
    console.log(`  S3  placeCell(${cellB.join(',')}, 0)                    ← clears B, A stays`);
    console.log(`  S4  placeCell(${cellA.join(',')}, 0)`);
    console.log(`  S5  placeCell(${cellA.join(',')}, 0x${Bs.page.toString(16)})   ← ${Bs.slug} alone, same cell A used for ${A.slug}`);
    console.log(`  S6  placeCell(${cellA.join(',')}, 0)`);
    if (!go) { console.log('\nNOTHING WAS WRITTEN.'); return 4; }

    // ── oracle: the edit-buffer body ──
    const dumpRaw = async (): Promise<{ hex: string; len: number }> => {
      const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
        timeoutMs: 8000, quietMs: 300, match: (fs) => fs.some((f) => f[5] === 0x79)
      });
      if (!frames.some((f) => f[5] === 0x79)) throw new Error(`incomplete dump (${frames.length} frames, no 0x79)`);
      const parsed = parsePresetDump(Uint8Array.from(frames.flat()), 0, MODEL);
      const { body } = decodeRawPatch(parsed.chunkPayloads);
      return { hex: Buffer.from(body).toString('hex'), len: body.length };
    };
    const longQuery = (): number[] => {
      const b = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, 0x2e, 0x00, 0x00, 0x00, 0x00, 0x00];
      while (b.length < 20) b.push(0x00);
      return [...b, fractalChecksum(b), 0xf7];
    };
    const d0 = await dumpRaw();
    bodyBefore = d0.hex;
    console.log(`\nedit buffer before: ${d0.len} B  sha ${createHash('sha256').update(Buffer.from(d0.hex, 'hex')).digest('hex').slice(0, 16)}`);
    const settle = async (n = 4): Promise<void> => { for (let i = 0; i < n; i++) { await session.transport.request(longQuery(), { timeoutMs: 1200, quietMs: 80 }); await sleep(45); } };
    await settle();

    /** A record printed in full, but compared with its per-read volatile offsets zeroed (see VOLATILE_IN_RECORD). */
    const stable = (rec: string): string => {
      const b = rec.split(' ');
      return b.map((x, i) => (VOLATILE_IN_RECORD.includes(REC_LO + i) ? '--' : x)).join(' ');
    };
    const readStage = async (label: string): Promise<string[]> => {
      const recs: string[] = [];
      const raw: number[][] = [];
      for (let i = 0; i < reads; i++) {
        const heard = await session.transport.request(longQuery(), { timeoutMs: 1200, quietMs: 80 });
        const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
        if (f) { recs.push(hex(f.slice(CONTENT_BASE, f.length - 2).slice(REC_LO, REC_HI))); raw.push(f); }
        await sleep(45);
      }
      // one tap per stage, so an independent reader can re-run the differ on this run (FORGEFX_TAP APPENDS,
      // so a single file cannot be split into stages after the fact)
      if (raw.length) {
        mkdirSync(outdir, { recursive: true });
        const slug = label.replace(/[^A-Za-z0-9.-]+/g, '_');
        writeFileSync(join(outdir, `record3-${slug}.tap`), raw.map((f) => `${Date.now()} RX ${hex(f)}`).join('\n') + '\n');
      }
      const dwellSeen: string[] = [];
      for (let i = 0; i < dwell; i++) {
        const heard = await session.transport.request(longQuery(), { timeoutMs: 1200, quietMs: 80 });
        const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
        if (f) dwellSeen.push(hex(f.slice(CONTENT_BASE, f.length - 2).slice(REC_LO, REC_HI)));
        await sleep(250);
      }
      const uniqStable = [...new Set([...recs, ...dwellSeen].map(stable))];
      const rawRec = [...new Set([...recs, ...dwellSeen])];
      stageValues[label] = [...recs, ...dwellSeen].map(stable);
      console.log(`  ${label.padEnd(28)} record#3 stable[25..31] = ${uniqStable.length === 1 ? uniqStable[0] : uniqStable.join(' | ')}   (${recs.length} reads + ${dwellSeen.length} dwell reads; data 24 excluded — ${new Set(rawRec.map((r) => r.slice(0, 2))).size} distinct)`);
      if (recs.length < reads) problems.push(`stage ${label} got ${recs.length}/${reads} replies`);
      if (uniqStable.length > 1) console.log('      !! more than one STABLE value in this stage — not attributable without more work');
      return recs;
    };
    const doPlace = async (row: number, col: number, eid: number, expectPlaced: boolean, label: string): Promise<void> => {
      const r = await session.driver.placeCell?.(row, col, eid);
      if (expectPlaced) placedByMe.push({ row, col });
      else { const i = placedByMe.findIndex((p) => p.row === row && p.col === col); if (i >= 0) placedByMe.splice(i, 1); }
      await sleep(500);
      const has = (await placedNow()).includes(eid);
      console.log(`  ${label}: placeCell(${row},${col},0x${eid.toString(16)}) → ${JSON.stringify(r)} · fn=0x13 eid present = ${has} ${has === expectPlaced ? '✔' : '✘'}`);
      if (has !== expectPlaced) problems.push(`${label} did not land`);
      await settle();
    };

    console.log('\n── state chain ──');
    await readStage('S0 baseline');
    await doPlace(cellA[0], cellA[1], A.page, true, 'S1 place A');
    await readStage(`S1 ${A.slug}${A.instance}`);
    await doPlace(cellB[0], cellB[1], Bs.page, true, 'S2 place B');
    await readStage(`S2 A+B`);
    await doPlace(cellB[0], cellB[1], 0, false, 'S3 clear B');
    await readStage(`S3 ${A.slug}${A.instance} again`);
    await doPlace(cellA[0], cellA[1], 0, false, 'S4 clear A');
    await readStage('S4 baseline again');
    await doPlace(cellA[0], cellA[1], Bs.page, true, `S5 place ${Bs.slug}${Bs.instance}`);
    await readStage(`S5 ${Bs.slug}${Bs.instance} alone`);
    await doPlace(cellA[0], cellA[1], 0, false, 'S6 clear B');
    await readStage('S6 baseline');

    // ── restore proof through the body ──
    const d1 = await dumpRaw();
    const same = d1.hex === bodyBefore;
    console.log(`\nRESTORE PROOF (edit-buffer BODY): ${same ? 'BYTE-IDENTICAL to before ✔' : 'DIFFERS ✘'}`);
    if (!same) problems.push('the edit buffer did not return byte-identical');

    // ── the verdict, decided by the pre-committed predictions ──
    const v = (s: string): string => (stageValues[s] && stageValues[s].length ? [...new Set(stageValues[s])].join('|') : '<none>');
    const s1 = [...new Set(stageValues[`S1 ${A.slug}${A.instance}`] ?? [])];
    const s2 = [...new Set(stageValues['S2 A+B'] ?? [])];
    const s3 = [...new Set(stageValues[`S3 ${A.slug}${A.instance} again`] ?? [])];
    const s4 = [...new Set(stageValues['S4 baseline again'] ?? [])];
    const s0 = [...new Set(stageValues['S0 baseline'] ?? [])];
    const s5 = [...new Set(stageValues[`S5 ${Bs.slug}${Bs.instance} alone`] ?? [])];
    console.log(`\n── the chain ──`);
    for (const k of [`S0 baseline`, `S1 ${A.slug}${A.instance}`, 'S2 A+B', `S3 ${A.slug}${A.instance} again`, 'S4 baseline again', `S5 ${Bs.slug}${Bs.instance} alone`, 'S6 baseline']) {
      console.log(`  ${k.padEnd(28)} ${v(k)}`);
    }
    const oneSame2 = s1.join() === s2.join();
    const aSameB = s1.join() === s5.join();
    const repeat = s1.join() === s3.join();
    const canonical = s0.join() === s4.join();
    console.log(`\n  one-block ≠ two-block: ${!oneSame2} · ${A.slug}-alone ≠ ${Bs.slug}-alone: ${!aSameB} · 1-block value repeats on return: ${repeat} · canonical value returns at S4: ${canonical}`);
    const verdict = !oneSame2 && !aSameB
      ? 'H_HASH — the value depends on the grid CONTENT (two blocks and a different block both give a different value)'
      : oneSame2 && aSameB
        ? 'H_FLAG — every structural edit gives the SAME value (1 = 2 blocks, any block type)'
        : !oneSame2 && aSameB
          ? 'H_COUNT — a count: the 2-block state differs, the block TYPE does not matter'
          : 'none of the pre-committed hypotheses — a new reading is needed (e.g. type matters but count does not)';
    console.log(`\nVERDICT: ${verdict}`);
    console.log(`  (repeatability ${repeat ? 'held' : 'FAILED'} · canonical restored ${canonical ? 'yes' : 'NO'})`);

    mkdirSync(outdir, { recursive: true });
    writeFileSync(join(outdir, 'record3-chain.json'), JSON.stringify({ stages: stageValues, verdict, sameBody: same }, null, 1) + '\n');
    console.log(`\n${problems.length === 0 ? 'arm completed, restore proven byte-identical through the body' : 'ARM INCOMPLETE'}`);
    for (const p of problems) console.log(`  • ${p}`);
    return problems.length === 0 ? 0 : 2;
  } finally {
    // FAIL-CLOSED: clear anything this run left placed
    for (const p of placedByMe) {
      try { console.log(`finally: clearing the cell this run placed at row ${p.row} col ${p.col}`); await session.driver.placeCell?.(p.row, p.col, 0); await sleep(400); } catch { /* reported above */ }
    }
    await sleep(50);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
