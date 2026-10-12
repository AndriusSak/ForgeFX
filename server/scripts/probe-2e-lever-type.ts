// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-2e-lever-type — ROUND 15e. LEVER A of the head-record analysis, pre-registered in
// review-2026-10-12/ANALYSIS-2E-HEAD-RECORDS.md (d). DRY-RUN by default: without `--go` it reads only and
// prints the plan; nothing is written.
//
// THE QUESTION. 42 of 44 head records of the `fn=0x01 sub=0x2e` reply are ONE value across the whole
// 835-reply corpus; only record #2 (the per-read trio) and record #3 (placement state) ever move. So the
// head is either mostly fixed scaffolding or mostly-unlevered state. Lever A changes an EXISTING block's
// MODEL IN PLACE — the instance set is untouched, the cell is untouched, only the family TYPE ordinal of one
// block changes.
//
// PRE-COMMITTED PREDICTION (H_TYPE — copied verbatim from the analysis, written before the first frame):
//   data 25 is a function of the PLACED-INSTANCE SET (which eids sit in which cells), not of any block's
//   model. A type change leaves the instance set unchanged ⇒ **record #3 does NOT move: data 25 holds its
//   current value and data 26/27 do not move. NO head record moves (0 of 44).** The only wire change is
//   inside the TAIL cell of that block (its 32-bit cell record's type field).
//   FALSIFIED IF any head record moves — specifically, if data 25 moves while the placed set is unchanged,
//   then data 25 encodes the block's MODEL, not its placement.
//
// WHAT IT DOES, in one session:
//   standing read → body dump (the oracle) → settle → stage BEFORE → setType(eid, other) → stage DURING →
//   setType(eid, original) → stage AFTER → body dump. One tap per stage. Each stage is N reads plus a dwell
//   with data 24..31 printed per read, so a value that moves on its own is separated from one that moved.
//
// SAFETY. Exactly two writes, both to the TYPE selector of ONE block, and the second is the exact inverse of
// the first (the original ordinal is READ first and re-written). The block is chosen BYPASSED by default so a
// model change cannot be audible. Nothing is stored to any slot. The restore is proved through the edit-buffer
// BODY — a different opcode path than the `0x2e` reply being diffed — and if the body does NOT return
// byte-identical the captured before-dump is reloaded into the edit buffer (`loadPresetBytes`, no slot
// written) and re-dumped, exactly as the placement arm does. A `finally` block restores the original type if
// anything threw. Exit 0 green · 2 a control or the restore failed · 3 no device · 4 dry-run (never a success).
//
// USAGE
//   npx tsx scripts/probe-2e-lever-type.ts                 # DRY RUN: prints the plan and the prediction
//   npx tsx scripts/probe-2e-lever-type.ts --go            # executes (owner's go-ahead required)
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { standingRead, standingLine, subQuery } from './standing-read.js';
import { parsePresetDump, decodeRawPatch } from 'forgefx-midi/devices/gen3';

const MODEL = 0x11;
const EDIT_BUFFER = 0x3fff;
const CONTENT_BASE = 12;
/** The derived per-READ volatile offsets (never mask 25/26/27 — the record that answers the question is there). */
const PER_READ = [22, 23, 24];
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const go = argv.includes('--go');
  const reads = Math.max(4, Number(arg('--reads') ?? 6));
  const dwell = Math.max(0, Number(arg('--dwell') ?? 10));
  const outdir = (arg('--outdir') ?? '/home/insn/repos/stack/review-2026-10-12/lever-type').replace('~', process.env.HOME ?? '');
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;

  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const problems: string[] = [];
  let restoreType: { eid: number; value: number } | null = null;
  let bodyBefore = '';
  let dumpFrames: number[] | null = null;
  try {
    console.log(`══ probe-2e-lever-type — LEVER A (model in place) · ${go ? 'EXECUTING (--go)' : 'DRY RUN (nothing will be written)'} ══`);
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);
    console.log('\nPRE-COMMITTED PREDICTION (H_TYPE, from ANALYSIS-2E-HEAD-RECORDS.md (d)):');
    console.log('  a model change with the instance set UNCHANGED moves NO head record (0 of 44); data 25 holds.');
    console.log('  FALSIFIED IF any head record moves — specifically if data 25 moves while the placed set is unchanged.');

    const sr = await standingRead(session, { note: 'R15e lever A — before' });
    console.log(`\n${standingLine(sr)}`);
    if (sr.verdict !== 'read (controls green)') problems.push('standing read controls not green');

    // ── pick a BYPASSED placed block with a type roster ──
    const state = (await session.driver.sceneState?.()) ?? [];
    const bypassed = state.filter((s) => s.bypassed).map((s) => s.effectId);
    const wanted = arg('--eid') !== undefined ? parseInt(arg('--eid')!, 16) : NaN;
    const candidates = Number.isFinite(wanted) ? [wanted] : bypassed;
    let eid = -1, original = -1, other = -1, rosterLen = 0, slug = '';
    for (const c of candidates) {
      const bp = await session.driver.blockParams?.(c);
      if (!bp?.type) continue;
      const models = session.driver.blockTypes?.(bp.slug) ?? [];
      if (models.length < 2) continue;
      eid = c; original = bp.type.value; rosterLen = models.length; slug = bp.slug;
      other = (original + 1) % rosterLen;
      console.log(`\ntarget block: 0x${c.toString(16)} (${bp.slug}, bypassed) · current type ${original} "${bp.type.name}" of ${rosterLen} models`);
      console.log(`  would write type ${other} "${models[other]?.name ?? ''}" and then restore type ${original}`);
      break;
    }
    if (eid < 0) { console.log('no bypassed placed block with a type roster ≥2 found — nothing to do.'); return 2; }

    if (!go) {
      console.log('\nDRY RUN — the plan above is what --go would execute:');
      console.log(`  W1  setType(0x${eid.toString(16)}, ${other})   ← the model ordinal of ONE block, instance set unchanged`);
      console.log(`  W2  setType(0x${eid.toString(16)}, ${original})   ← the exact inverse`);
      console.log('  proof: the fn=0x77/0x78/0x79 EDIT-BUFFER BODY must read byte-identical before W1 and after W2.');
      console.log('  fallback if it does not: reload the captured before-dump into the edit buffer (no slot written).');
      console.log('\nNOTHING WAS WRITTEN.');
      return 4;
    }

    const dump = async (): Promise<{ hex: string; len: number; frames: number[] }> => {
      const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
        timeoutMs: 8000, quietMs: 300, match: (fs) => fs.some((f) => f[5] === 0x79)
      });
      if (!frames.some((f) => f[5] === 0x79)) throw new Error(`incomplete dump (${frames.length} frames, no 0x79)`);
      const parsed = parsePresetDump(Uint8Array.from(frames.flat()), 0, MODEL);
      const { body } = decodeRawPatch(parsed.chunkPayloads);
      return { hex: Buffer.from(body).toString('hex'), len: body.length, frames: frames.flat() };
    };
    const d0 = await dump(); bodyBefore = d0.hex; dumpFrames = d0.frames;
    console.log(`\nedit buffer before: ${d0.len} B  sha ${createHash('sha256').update(Buffer.from(d0.hex, 'hex')).digest('hex').slice(0, 16)}`);
    const settle = async (n = 4): Promise<void> => { for (let i = 0; i < n; i++) { await session.transport.request(subQuery(0x2e, [0, 0, 0, 0, 0]), { timeoutMs: 1200, quietMs: 80 }); await sleep(45); } };
    await settle();

    const readStage = async (label: string): Promise<void> => {
      const recs: string[] = []; const raw: number[][] = [];
      for (let i = 0; i < reads; i++) {
        const heard = await session.transport.request(subQuery(0x2e, [0, 0, 0, 0, 0]), { timeoutMs: 1200, quietMs: 80 });
        const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
        if (f) { recs.push(hex(f.slice(CONTENT_BASE, f.length - 2).slice(24, 32))); raw.push(f); }
        await sleep(45);
      }
      const dwellSeen: string[] = [];
      for (let i = 0; i < dwell; i++) {
        const heard = await session.transport.request(subQuery(0x2e, [0, 0, 0, 0, 0]), { timeoutMs: 1200, quietMs: 80 });
        const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
        if (f) dwellSeen.push(hex(f.slice(CONTENT_BASE, f.length - 2).slice(24, 32)));
        await sleep(250);
      }
      const all = [...recs, ...dwellSeen];
      // compare on everything BUT the per-read trio (data 24 is inside record #3)
      const stable = new Set(all.map((r) => r.split(' ').map((b, i) => (PER_READ.includes(24 + i) ? '--' : b)).join(' ')));
      console.log(`  ${label.padEnd(8)} record#3[25..31] = ${[...stable].join(' | ')}   (${recs.length} reads + ${dwellSeen.length} dwell reads)`);
      if (stable.size > 1) console.log('      !! more than one stable value in this stage — read it before using it');
      if (raw.length) {
        mkdirSync(outdir, { recursive: true });
        writeFileSync(join(outdir, `lever-type-${label}.tap`), raw.map((f) => `${Date.now()} RX ${hex(f)}`).join('\n') + '\n');
      }
    };

    console.log('\nBEFORE:');
    await readStage('before');
    console.log(`\nWRITE 1 — setType(0x${eid.toString(16)}, ${other})`);
    const w1 = await session.driver.setType?.(eid, other);
    restoreType = { eid, value: original };
    await sleep(700);
    const bp1 = await session.driver.blockParams?.(eid);
    console.log(`  read back through blockParams: type = ${bp1?.type ? `${bp1.type.value} "${bp1.type.name}"` : '<null>'} ${bp1?.type?.value === other ? '✔ LANDED' : '✘ DID NOT LAND'}`);
    if (bp1?.type?.value !== other) problems.push('WRITE 1 did not land (blockParams reads the old type)');
    await settle();
    console.log('DURING:'); await readStage('during');

    console.log(`\nRESTORE — setType(0x${eid.toString(16)}, ${original})`);
    const w2 = await session.driver.setType?.(eid, original);
    restoreType = null;
    await sleep(700);
    const bp2 = await session.driver.blockParams?.(eid);
    console.log(`  read back: type = ${bp2?.type ? `${bp2.type.value} "${bp2.type.name}"` : '<null>'} ${bp2?.type?.value === original ? '✔ RESTORED' : '✘ NOT RESTORED'}`);
    if (bp2?.type?.value !== original) problems.push('the restore did not land');
    await settle();
    console.log('AFTER:'); await readStage('after');

    const d1 = await dump();
    const same = d1.hex === bodyBefore;
    console.log(`\nRESTORE PROOF (independent path: the edit-buffer BODY): ${same ? 'BYTE-IDENTICAL ✔' : 'DIFFERS ✘'}`);
    if (!same) {
      problems.push('the edit buffer did not return byte-identical');
      const n = Math.min(bodyBefore.length, d1.hex.length) / 2;
      const at: number[] = [];
      for (let i = 0; i < n; i++) if (bodyBefore.slice(i * 2, i * 2 + 2) !== d1.hex.slice(i * 2, i * 2 + 2)) at.push(i);
      console.log(`  ${at.length} differing body byte(s)${at.length ? `, first ${at.slice(0, 12).join(', ')}` : ''}`);
      console.log('  → FALLBACK: reloading the captured before-dump into the edit buffer (no slot written)');
      await session.driver.loadPresetBytes?.(Uint8Array.from(dumpFrames!));
      await sleep(900);
      const d2 = await dump();
      console.log(`  after the reload: ${d2.hex === bodyBefore ? 'BYTE-IDENTICAL ✔' : 'STILL DIFFERS ✘'}`);
      if (d2.hex !== bodyBefore) problems.push('even the reload did not restore the edit buffer');
    }
    console.log(`\nwrite results: ${JSON.stringify(w1)} / ${JSON.stringify(w2)}`);
    console.log(`NEXT (offline): npx tsx scripts/diff-2e-head-vs-grid.ts ${outdir}/lever-type-before.tap ${outdir}/lever-type-during.tap ${outdir}/lever-type-after.tap --mask 22,23,24`);
    console.log(`\nVERDICT (pre-committed): ${problems.length ? 'ARM INCOMPLETE — do not read record #3 above as a result' : 'H_TYPE holds iff the differ reports 0 head records changed'}`);
    for (const p of problems) console.log(`  • ${p}`);
    return problems.length === 0 ? 0 : 2;
  } finally {
    if (restoreType) {
      try { console.log(`finally: restoring type ${restoreType.value} on 0x${restoreType.eid.toString(16)}`); await session.driver.setType?.(restoreType.eid, restoreType.value); await sleep(500); } catch { /* reported above */ }
    }
    await sleep(50);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
