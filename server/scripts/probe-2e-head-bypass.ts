// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-2e-head-bypass — ROUND 14, the `H_head` arm. ONE self-restoring bypass toggle, then the diff is
// decided offline by `scripts/diff-2e-head-vs-grid.ts`.
//
// THE QUESTION. The 590-byte `fn=0x01 sub=0x2e` reply is TWO structures: a TAIL the repo already decodes
// (`parseFm3GridLayout`) and an 8-byte-periodic HEAD holding ~20 one-hot ladders, undecoded. `H_head`: when ONE
// block's state changes, how many of the ~44 HEAD records change, and do they move 1:1 with one TAIL cell?
//
// OUTCOMES — pre-committed, so the result cannot be read after the fact:
//   exactly 1 head record + exactly 1 tail cell, reverting      ⇒ per-placement state table
//   0 head records while a tail cell moves                      ⇒ head is preset-static metadata
//   1+ head records and 0 tail cells                            ⇒ head tracks something the grid does not
//   changes that do not revert                                  ⇒ volatile / unattributable
//   nothing changes anywhere                                     ⇒ the region does not reflect BYPASS
//                                                                 (H_head then needs a PLACEMENT change —
//                                                                 moving a block between grid cells — not a
//                                                                 bypass toggle; the source says a scene switch
//                                                                 never changes the grid structure either, so a
//                                                                 scene arm would be no better)
// The last row is the one this arm can plausibly land on, and it is a real result, not a failure: the write's
// landing is proved independently through the `fn=0x13` status dump, so "the unit changed and this region did
// not" is a measured statement about the region.
//
// WHY THE TAP IS SPLIT PER STAGE. `FORGEFX_TAP` APPENDS, and `diff-2e-head-vs-grid.ts` maps one file → one
// stage. Writing one file per stage keeps the three stages separable and stops a re-run from silently
// concatenating two different experiments (which cost an independent verifier a wrong reading earlier today).
//
// THE MASK. The per-read volatile trio sits at data 22/23/24, INSIDE head records #2 and #3. The differ is
// therefore run with `--mask 22,23,24`; without it a one-record change is indistinguishable from known drift.
// This probe also reports, per stage, whether every OTHER byte of the reply is stable across the N reads —
// that is the drift control for this arm.
//
// SAFETY. Exactly one WRITE (the bypass toggle), self-restoring, and the restore is proved through a DIFFERENT
// path (the fn=0x13 status dump). The original bypass is read from that dump first. A failed restore exits 6
// with the eid and the value it could not restore. Nothing else on the unit is touched.
//
// USAGE  npx tsx scripts/probe-2e-head-bypass.ts [--port /dev/ttyACM0] [--eid 0x3a] [--reads 3] [--outdir DIR]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const CONTENT_BASE = 12;            // frame.slice(12,-2) is this repo's `data` space (see the differ's header)
const TRIO = [22, 23, 24];          // the per-read volatile trio, in that same space
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function longQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, 0x2e, 0x00, 0x00, 0x00, 0x00, 0x00];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}
function patchNameQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x0d, 0x7f, 0x7f];
  return [...body, fractalChecksum(body), 0xf7];
}
function patchNameOf(frames: readonly number[][]): string {
  const f = frames.find((x) => x[5] === 0x0d);
  if (!f) return '<no reply>';
  return String.fromCharCode(...f.slice(6, -2).filter((b) => b >= 0x20 && b < 0x7f)).trim();
}
/** Content without the volatile trio — the ONLY part of the reply that can be compared across reads. */
const minusTrio = (content: readonly number[]): string => hex(content.map((b, i) => (TRIO.includes(i) ? 0 : b)));

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const reads = Math.max(1, Number(arg('--reads') ?? 3));
  const outdir = arg('--outdir') ?? join(process.cwd(), 'test/fixtures/query-subs-decode');
  const forceEid = arg('--eid') !== undefined ? parseInt(arg('--eid')!, 16) : undefined;
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  let eid = -1;
  let wasBypassed: boolean | undefined;
  try {
    console.log(`device ${session.label} · ONE self-restoring bypass toggle, ${reads} long 0x2e replies per stage`);
    console.log('pre-committed outcomes: 1 head record + 1 tail cell reverting ⇒ per-placement · tail only ⇒ preset-static');
    console.log('  · head only ⇒ tracks something the grid does not · no revert ⇒ volatile · NOTHING ⇒ the region does not reflect BYPASS');
    console.log(`\npreset in the edit buffer (fn=0x0d): "${patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }))}"`);

    const state = (await session.driver.sceneState?.()) ?? [];
    const placed = state.map((s) => s.effectId).sort((a, b) => a - b);
    console.log(`fn=0x13 placed: ${placed.map((e) => '0x' + e.toString(16)).join(' ')}`);
    eid = forceEid ?? (placed.includes(0x3a) ? 0x3a : placed[Math.min(2, Math.max(0, placed.length - 1))] ?? -1);
    if (eid < 0 || !placed.includes(eid)) { console.log(`refusing: eid 0x${eid.toString(16)} is not a placed block — nothing written.`); return 2; }
    wasBypassed = state.find((s) => s.effectId === eid)?.bypassed;
    if (wasBypassed === undefined) { console.log('refusing: cannot read the target block\'s bypass state — nothing written.'); return 2; }
    console.log(`target eid 0x${eid.toString(16)} · bypassed=${wasBypassed} → will toggle to ${!wasBypassed} and restore to ${wasBypassed}`);

    const longReplies = async (): Promise<number[][]> => {
      const out: number[][] = [];
      for (let i = 0; i < reads; i++) {
        const heard = await session.transport.request(longQuery(), { timeoutMs: 1200, quietMs: 80 });
        const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
        if (f) out.push(f);
        await sleep(40);
      }
      return out;
    };
    const stages: Record<string, number[][]> = {};
    const collect = async (label: string): Promise<void> => {
      const frames = await longReplies();
      stages[label] = frames;
      const contents = frames.map((f) => f.slice(CONTENT_BASE, f.length - 2));
      const stable = new Set(contents.map(minusTrio)).size === 1;
      const trioSamples = new Set(contents.map((c) => TRIO.map((i) => c[i] ?? -1).join(',')));
      console.log(`  ${label.padEnd(6)} ${frames.length} long reply(ies) · ${frames[0] ? frames[0]!.length + 'B' : '--'} · non-trio bytes ${stable ? 'STABLE' : 'DRIFT'}` +
        ` · trio distinct ${trioSamples.size}/${contents.length} (expected >1: it is per-read)`);
      if (frames.length !== reads) console.log(`    !! expected ${reads} long replies, got ${frames.length} — the stage is thin`);
    };

    console.log('\nBEFORE (no write):');
    await collect('before');
    // ── the drift control the differ cannot do: the stage must be stable in everything but the trio ──
    const beforeContents = stages.before!.map((f) => f.slice(CONTENT_BASE, f.length - 2));
    if (new Set(beforeContents.map(minusTrio)).size !== 1) {
      console.log('ABORT: the BEFORE stage is not stable outside the volatile trio — a later change could not be');
      console.log('  attributed to the write. Nothing has been written. Re-run when the link is quieter.');
      return 2;
    }

    console.log(`\nWRITE setBypass(0x${eid.toString(16)}, ${!wasBypassed})`);
    const w = await session.driver.setBypass?.(eid, !wasBypassed);
    await sleep(500);
    const duringState = ((await session.driver.sceneState?.()) ?? []).find((s) => s.effectId === eid)?.bypassed;
    console.log(`  landing check via the fn=0x13 status dump (a different path than the write): bypassed=${duringState} ${duringState === !wasBypassed ? '✔ LANDED' : '✘ DID NOT LAND'}`);
    console.log('DURING:');
    await collect('during');

    console.log(`\nRESTORE setBypass(0x${eid.toString(16)}, ${wasBypassed})`);
    const r = await session.driver.setBypass?.(eid, wasBypassed);
    await sleep(500);
    console.log('AFTER:');
    await collect('after');
    const afterState = ((await session.driver.sceneState?.()) ?? []).find((s) => s.effectId === eid)?.bypassed;
    console.log(`\n  write results: ${JSON.stringify(w)} / restore ${JSON.stringify(r)}`);
    console.log(`  restore proof via the fn=0x13 status dump (a DIFFERENT path): bypassed=${afterState} (was ${wasBypassed}) → ${afterState === wasBypassed ? 'RESTORED' : 'NOT CONFIRMED'}`);
    console.log(`  preset name after the arm: "${patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }))}"`);

    // stage taps, one file per stage (FORGEFX_TAP appends; the differ maps one file to one stage)
    mkdirSync(outdir, { recursive: true });
    const written: string[] = [];
    for (const label of ['before', 'during', 'after']) {
      const p = join(outdir, `2e-head-bypass-${label}.tap`);
      writeFileSync(p, stages[label]!.map((f) => `${Date.now()} RX ${hex(f)}`).join('\n') + '\n');
      written.push(p);
    }
    for (const p of written) console.log(`  wrote ${p}`);
    console.log(`\nNEXT (offline): npx tsx scripts/diff-2e-head-vs-grid.ts ${written.map((p) => p.replace(process.cwd() + '/', '')).join(' ')} --mask ${TRIO.join(',')}`);

    if (afterState !== wasBypassed) { console.log(`!! RESTORE NOT CONFIRMED for eid 0x${eid.toString(16)} — it should be bypassed=${wasBypassed}. Check the unit.`); return 6; }
    console.log('\n  restore confirmed; the unit is back as it was.');
    return 0;
  } finally {
    if (eid >= 0 && wasBypassed !== undefined) {
      const now = ((await session.driver.sceneState?.()) ?? []).find((s) => s.effectId === eid)?.bypassed;
      if (now !== wasBypassed) {
        console.log(`finally: bypass on 0x${eid.toString(16)} reads ${now}, expected ${wasBypassed} — re-issuing the restore.`);
        await session.driver.setBypass?.(eid, wasBypassed);
        await sleep(400);
      }
    }
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
