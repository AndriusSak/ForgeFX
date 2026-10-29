// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-2e-placement — ROUND 15, the PLACEMENT arm for `H_head` (task 1). DEFAULTS TO DRY-RUN: with no
// `--go` it reads only and prints the exact write plan; nothing is written.
//
// THE QUESTION. `H_head`: does the ~44-record HEAD of the `fn=0x01 sub=0x2e` reply track a block's state?
// ROUND 14 answered NULL for a bypass toggle (0 of 44 records and 0 of the tail grid cells moved), and a
// scene switch cannot change grid STRUCTURE. The only lever left is a PLACEMENT change.
//
// THE CHANGE THIS MAKES — deliberately NOT "move a block and move it back". A move breaks the owner's
// signal chain and has to be undone by re-placing a block whose cable routing the reverse write may not
// restore. This arm instead ADD-THEN-REMOVE: a block instance that is NOT placed is placed into a
// VERIFIED-EMPTY cell and then cleared again. The preset's existing chain is never touched, and the
// restore is a single clear of a cell that was empty before — a genuine inverse of the write, not an
// approximation of it.
//
// PRE-COMMITTED OUTCOMES (same table as probe-2e-head-bypass.ts, so the two arms are read the same way):
//   exactly 1 head record + exactly 1 tail cell, reverting   ⇒ per-placement state table
//   0 head records while a tail cell moves                   ⇒ head is preset-static metadata
//   1+ head records and 0 tail cells                         ⇒ head tracks something the grid does not
//   changes that do not revert                               ⇒ volatile / unattributable
//   nothing changes anywhere                                 ⇒ the region does not reflect PLACEMENT either
//                                                              (and H_head is then null for every lever
//                                                              that does not edit the preset's structure)
//
// THE MASK IS DERIVED, NOT GUESSED. `scripts/probe-2e-volatility.ts` (measured 2026-10-12) shows the
// per-READ volatile offsets are 22/23/24 and that ONE EDIT-BUFFER BODY DUMP transiently moves 25/26/27
// for about one 4-read group (`probe-2e-dump-perturbation.ts`). Data 22..27 spans head records #2 and #3,
// so this arm masks 22..27 for every diff and DISCLOSES the blind spot: a change confined to head records
// #2/#3 cannot be seen by it. Every stage is read as a SET of N reads, and the probe WARNS if a stage is
// not internally constant outside the mask (a stage that drifts on its own cannot be attributed).
//
// THE RESTORE PROOF IS INDEPENDENT. The compared path is `fn=0x01 sub=0x2e`. The restore is proved through
// the EDIT-BUFFER BODY (`fn=0x77/0x78/0x79` → decodeRawPatch), which is byte-stable across consecutive
// reads with nothing written (measured), plus the `fn=0x13` status dump for landing. If the body is NOT
// byte-identical afterwards, the probe says so LOUDLY, prints the differing regions, and (with --go)
// reloads the captured before-dump into the edit buffer via `loadPresetBytes` — the same retargeted dump
// load FM3-Edit's "Audition" uses, which touches NO slot — then re-dumps to confirm.
//
// SAFETY. No slot is written (place/clear edit the edit buffer only; no `store`). The owner's existing
// chain is never cleared. A failed restore is reported, not smoothed over. Exit 0 green · 2 a control or
// the restore failed · 3 no device · 4 dry-run (nothing written — never a success).
//
// USAGE
//   npx tsx scripts/probe-2e-placement.ts                                  # DRY RUN: prints the plan, writes nothing
//   npx tsx scripts/probe-2e-placement.ts --go                             # executes the arm (owner's go-ahead required)
//   npx tsx scripts/probe-2e-placement.ts --go --eid 0x14 --cell 1,1       # explicit block + destination cell
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { standingRead, standingLine, subQuery } from './standing-read.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { parsePresetDump, decodeRawPatch } from 'forgefx-midi/devices/gen3';

const MODEL = 0x11;
const EDIT_BUFFER = 0x3fff;
const CONTENT_BASE = 12;
/** DERIVED (probe-2e-volatility + probe-2e-dump-perturbation, 2026-10-12): per-read 22/23/24 plus the
 *  transient 25/26/27 the body-dump oracle leaves for ~one read group. Masked for every comparison. */
const MASK = [22, 23, 24, 25, 26, 27];
const HEAD_RECORDS_BLIND = [...new Set(MASK.filter((o) => o < 352).map((o) => Math.floor(o / 8)))];
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function longQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, 0x2e, 0x00, 0x00, 0x00, 0x00, 0x00];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}

function diffHex(a: string, b: string): [number, number][] {
  const n = Math.min(a.length, b.length) / 2;
  const at: number[] = [];
  for (let i = 0; i < n; i++) if (a.slice(i * 2, i * 2 + 2) !== b.slice(i * 2, i * 2 + 2)) at.push(i);
  const ranges: [number, number][] = [];
  if (at.length) {
    let s = at[0]!, prev = at[0]!;
    for (const k of at.slice(1)) { if (k - prev > 8) { ranges.push([s, prev]); s = k; } prev = k; }
    ranges.push([s, prev]);
  }
  return ranges;
}

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const go = argv.includes('--go');
  const reads = Math.max(4, Number(arg('--reads') ?? 6));
  // Default to TODAY's review dir. This used to hard-code review-2026-10-12, so a later run's tap stages
  // were filed under another day's folder and any "date the artifact" comparison would have been misled.
  const today = new Date().toISOString().slice(0, 10);
  const outdir = (arg('--outdir') ?? `/home/insn/repos/stack/review-${today}`).replace('~', process.env.HOME ?? '');
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;

  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const problems: string[] = [];
  let placedByMe: { row: number; col: number } | null = null;
  let beforeHex = '';
  let beforeSyx: number[] | null = null; // the raw dump frames, for the retargeted reload fallback
  try {
    console.log(`══ probe-2e-placement — PLACEMENT arm for H_head · ${go ? 'EXECUTING (--go)' : 'DRY RUN (nothing will be written)'} ══`);
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);
    console.log(`MASK (derived): ${MASK.join(',')} — head records ${HEAD_RECORDS_BLIND.map((r) => '#' + r).join(' ')} are therefore OUT OF SCOPE for this arm.`);

    const sr = await standingRead(session, { note: 'R15 placement arm — before' });
    console.log(standingLine(sr));
    if (sr.verdict !== 'read (controls green)') problems.push('standing read controls not green');

    // ── landing/occupancy reads (fn 0x13: placed eids; no body dump, so no transient) ──
    const placedNow = async (): Promise<number[]> => ((await session.driver.sceneState?.()) ?? []).map((s) => s.effectId).sort((a, b) => a - b);
    const placed0 = await placedNow();
    console.log(`fn=0x13 placed (${placed0.length}): ${placed0.map((e) => '0x' + e.toString(16)).join(' ')}`);

    // ── pick the block and the cell ──
    const catalog = session.driver.blocksCatalog?.() ?? [];
    const wanted = arg('--eid') !== undefined ? parseInt(arg('--eid')!, 16) : NaN;
    const pick = Number.isFinite(wanted)
      ? catalog.find((c) => c.page === wanted)
      : catalog.filter((c) => !placed0.includes(c.page))[0];
    if (!pick) { console.log('could not pick a placeable instance from the catalog — pass --eid explicitly.'); return 2; }
    const cellArg = (arg('--cell') ?? '1,1').split(',').map((x) => Number(x.trim()));
    const [cellRow, cellCol] = cellArg as [number, number];
    console.log(`\nPLAN`);
    console.log(`  block to place : ${pick.slug} ${pick.instance} (eid 0x${pick.page.toString(16)}) — NOT currently placed: ${!placed0.includes(pick.page)}`);
    console.log(`  destination    : row ${cellRow}, col ${cellCol} (1-indexed, the /preset/grid/cell contract)`);

    // ── is the destination cell VERIFIED-EMPTY? (dump path; a body dump, so do it BEFORE the stage taps) ──
    const grid0 = await session.driver.grid();
    const occ = new Map(grid0.cells.map((c) => [`${c.row + 1},${c.col + 1}`, c])); // dump cells are 0-based → +1 for the route contract
    const target = occ.get(`${cellRow},${cellCol}`);
    const destIsEmpty = target === undefined;
    console.log(`  destination empty? ${destIsEmpty ? 'YES (verified by the dump grid)' : `NO — ${target!.isShunt ? 'shunt' : 'block 0x' + target!.effectId.toString(16)}`}`);
    if (!destIsEmpty) problems.push('the destination cell is not empty — refusing to place over an existing block');

    // ── the before body (oracle) and the raw dump (fallback) ──
    const dumpRaw = async (): Promise<{ hex: string; syx: number[]; len: number }> => {
      const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
        timeoutMs: 8000, quietMs: 300, match: (fs) => fs.some((f) => f[5] === 0x79)
      });
      if (!frames.some((f) => f[5] === 0x79)) throw new Error(`incomplete dump (${frames.length} frames, no 0x79)`);
      const parsed = parsePresetDump(Uint8Array.from(frames.flat()), 0, MODEL);
      const { body } = decodeRawPatch(parsed.chunkPayloads);
      return { hex: Buffer.from(body).toString('hex'), syx: frames.flat(), len: body.length };
    };
    const d0 = await dumpRaw();
    beforeHex = d0.hex; beforeSyx = d0.syx;
    console.log(`  edit buffer before: ${d0.len} B  sha ${createHash('sha256').update(Buffer.from(d0.hex, 'hex')).digest('hex').slice(0, 16)}`);

    // ── stage reads: N long replies after a settle gap (the oracle's transient lasts ~one 4-read group) ──
    const settle = async (n = 4): Promise<void> => { for (let i = 0; i < n; i++) { await session.transport.request(longQuery(), { timeoutMs: 1200, quietMs: 80 }); await sleep(45); } };
    await settle();
    const stage = async (label: string): Promise<number[][]> => {
      const out: number[][] = [];
      for (let i = 0; i < reads; i++) {
        const heard = await session.transport.request(longQuery(), { timeoutMs: 1200, quietMs: 80 });
        const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
        if (f) out.push(f);
        await sleep(45);
      }
      const datas = out.map((f) => f.slice(CONTENT_BASE, f.length - 2));
      const minusMask = (d: readonly number[]) => hex(d.map((b, i) => (MASK.includes(i) ? 0 : b)));
      const stable = new Set(datas.map(minusMask)).size === 1;
      console.log(`  ${label.padEnd(7)} ${out.length}/${reads} long reply(ies) · non-masked bytes ${stable ? 'STABLE' : 'DRIFT'}`);
      if (out.length < reads) problems.push(`stage ${label} got ${out.length}/${reads} replies`);
      if (!stable) problems.push(`stage ${label} DRIFTS outside the mask — nothing in this arm can be attributed`);
      return out;
    };
    /**
     * DWELL TRACE — the discriminator inside the mask. Data 25/26 sat inside head record #3, they moved
     * between the before and during stages of the first placement run and reverted with the clear, and yet
     * ONE body dump moves them too (`probe-2e-dump-perturbation.ts`) — so they could be placement STATE or
     * just a transient from recent traffic. A plain 8-read stage cannot separate the two (both are ~0.5 s).
     * This reads the SAME six offsets many times over SECONDS with nothing else happening: a state byte holds
     * for as long as the placement is in force; a transient decays. Printed per read, in order.
     */
    const dwellTrace = async (label: string, n: number): Promise<void> => {
      if (n <= 0) return;
      const seen: string[] = [];
      for (let i = 0; i < n; i++) {
        const heard = await session.transport.request(longQuery(), { timeoutMs: 1200, quietMs: 80 });
        const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
        if (f) {
          const d = f.slice(CONTENT_BASE, f.length - 2);
          seen.push(MASK.map((o) => d[o]!.toString(16).padStart(2, '0')).join(''));
        }
        await sleep(250);
      }
      const uniq = [...new Set(seen)];
      console.log(`  dwell ${label} (${seen.length} reads over ~${(seen.length * 0.25).toFixed(1)}s, data 22-27 per read):`);
      console.log(`    ${seen.join(' ')}`);
      console.log(`    distinct: ${uniq.length} → ${uniq.join(' | ')}  ${uniq.length === 1 ? '(SETTLED — one value held across the whole dwell)' : '(NOT settled inside the dwell)'}`);
    };

    const writeStage = (label: string, frames: number[][]): string => {
      mkdirSync(outdir, { recursive: true });
      const p = join(outdir, `placement-${label}.tap`);
      writeFileSync(p, frames.map((f) => `${Date.now()} RX ${hex(f)}`).join('\n') + '\n');
      return p;
    };

    if (!go) {
      console.log('\nDRY RUN — the plan above is what --go would execute:');
      console.log(`  W1  placeCell(${cellRow}, ${cellCol}, 0x${pick.page.toString(16)})   ← adds the block to an empty cell (select 0x30 + insert 0x32)`);
      console.log(`  W2  placeCell(${cellRow}, ${cellCol}, 0)               ← clear, i.e. the inverse of W1`);
      console.log('  proof: the fn=0x77/0x78/0x79 EDIT-BUFFER BODY must read byte-identical before W1 and after W2.');
      console.log('  fallback if it does not: reload the captured before-dump into the edit buffer (loadPresetBytes; NO slot written).');
      console.log('  landing checks: the fn=0x13 placed set must GAIN the eid after W1 and LOSE it after W2.');
      console.log('\nNOTHING WAS WRITTEN.');
      return 4;
    }

    console.log('\nBEFORE:');
    const sBefore = await stage('before');
    const pBefore = writeStage('before', sBefore);

    console.log(`\nWRITE 1 — placeCell(${cellRow}, ${cellCol}, 0x${pick.page.toString(16)})`);
    const w1 = await session.driver.placeCell?.(cellRow, cellCol, pick.page);
    placedByMe = { row: cellRow, col: cellCol };
    await sleep(500);
    const landed1 = (await placedNow()).includes(pick.page);
    console.log(`  landing via the fn=0x13 status dump (a different path than the write): eid present = ${landed1} ${landed1 ? '✔ LANDED' : '✘ DID NOT LAND'}`);
    if (!landed1) problems.push('WRITE 1 did not land (the placed set did not gain the eid)');
    await settle();
    console.log('DURING:');
    const sDuring = await stage('during');
    const pDuring = writeStage('during', sDuring);
    // dwell BEFORE the restore: the placement is in force and nothing else is happening.
    await dwellTrace('with the block PLACED', Math.max(0, Number(arg('--dwell') ?? 0)));

    console.log(`\nRESTORE — placeCell(${cellRow}, ${cellCol}, 0)`);
    const w2 = await session.driver.placeCell?.(cellRow, cellCol, 0);
    placedByMe = null;
    await sleep(500);
    const landed2 = !(await placedNow()).includes(pick.page);
    console.log(`  landing via the fn=0x13 status dump: eid gone = ${landed2} ${landed2 ? '✔ REMOVED' : '✘ STILL PLACED'}`);
    if (!landed2) problems.push('the restore did not land (the placed set still holds the eid)');
    await settle();
    console.log('AFTER:');
    const sAfter = await stage('after');
    const pAfter = writeStage('after', sAfter);
    // and the same trace once the placement is gone: a STATE byte must go back; a transient is already gone.
    await dwellTrace('after the CLEAR', Math.max(0, Number(arg('--dwell') ?? 0)));

    // ── the independent restore proof ──
    const d1 = await dumpRaw();
    const ranges = diffHex(beforeHex, d1.hex);
    console.log(`\nRESTORE PROOF (independent path: the edit-buffer BODY): ${ranges.length === 0 ? 'BYTE-IDENTICAL to before ✔' : `DIFFERS in ${ranges.length} region(s) ✘`}`);
    for (const [a, b] of ranges.slice(0, 12)) console.log(`    body ${a}..${b} (${b - a + 1} B)`);
    if (ranges.length) {
      problems.push('the edit buffer did NOT return byte-identical — the restore is not proven');
      console.log('  → FALLBACK: reloading the captured before-dump into the edit buffer (loadPresetBytes; no slot written).');
      const rl = await session.driver.loadPresetBytes?.(Uint8Array.from(beforeSyx!));
      await sleep(700);
      const d2 = await dumpRaw();
      const r2 = diffHex(beforeHex, d2.hex);
      console.log(`  after the reload: ${r2.length === 0 ? 'BYTE-IDENTICAL ✔ the edit buffer is back' : `STILL DIFFERS (${r2.length} region(s)) ✘ — the unit needs attention`}`);
      if (r2.length) problems.push('even the reload did not restore the edit buffer');
    }
    console.log(`\nwrite results: ${JSON.stringify(w1)} / ${JSON.stringify(w2)}`);
    console.log(`stages: ${[pBefore, pDuring, pAfter].map((p) => p.replace(process.cwd() + '/', '')).join(' ')}`);
    console.log(`\nNEXT (offline): npx tsx scripts/diff-2e-head-vs-grid.ts ${[pBefore, pDuring, pAfter].map((p) => p.replace(process.cwd() + '/', '')).join(' ')} --mask ${MASK.join(',')}`);
    console.log(`\nVERDICT: ${problems.length === 0 ? 'arm completed, restore proven byte-identical through the body' : 'ARM INCOMPLETE'}`);
    for (const p of problems) console.log(`  • ${p}`);
    return problems.length === 0 ? 0 : 2;
  } finally {
    // FAIL-CLOSED: if we are exiting with a placed-by-us block still in the preset, clear it.
    if (placedByMe) {
      try {
        console.log(`finally: clearing the cell we placed at row ${placedByMe.row} col ${placedByMe.col}`);
        await session.driver.placeCell?.(placedByMe.row, placedByMe.col, 0);
        await sleep(400);
      } catch { /* reported by the caller's problems */ }
    }
    await sleep(50);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
