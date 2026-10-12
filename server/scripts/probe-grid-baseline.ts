// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-grid-baseline — READ-ONLY. The PRE-FLIGHT for the ROUND 15 PLACEMENT arm (task 1), and the
// independent oracle that arm needs.
//
// THE ARM IT PREPARES (do not run that part from here — it is a preset write and needs the owner's
// go-ahead): `H_head` was null for a bypass toggle and a scene switch cannot change grid STRUCTURE, so
// the one lever left is MOVING a block between grid cells. The arm's own outcome table (in
// probe-2e-head-bypass.ts) decides it: 1 head record + 1 tail cell reverting ⇒ per-placement state table.
//
// WHAT THIS SCRIPT ANSWERS, in order, all of it read-only:
//
//   1. STANDING READ at the head (hole record · preset name · placed set · scene) — the four frames the
//      round-15 instrument is for. Logged, so this run is DATED.
//
//   2. IS THE INDEPENDENT ORACLE STABLE? The placement arm must prove its RESTORE through a path OTHER
//      than the one it compares (`fn=0x01 sub=0x2e`). The candidate is the EDIT-BUFFER BODY
//      (`fn=0x77/0x78/0x79` → `decodeRawPatch`), i.e. a different opcode entirely. An oracle that moves
//      on its own is not an oracle, so this dumps the body twice with NOTHING written in between and
//      diffs the two hex strings byte for byte, reporting every differing offset. `STABLE` is the
//      pre-condition for the arm to be sound; a diff here means the arm must find another oracle.
//
//   3. THE GRID, TWO WAYS. `driver.grid()` decodes the DUMP (fn 0x77…) — the independent path — while
//      the `fn=0x01 sub=0x2e` reply carries the same grid in its TAIL via `parseGen3GridLayout`. Printing
//      both and their agreement is what makes either trustworthy: a cell that differs between the two
//      paths is a finding, not a detail.
//
//   4. WHICH CELLS ARE EMPTY (candidates for the one-block move) and which block sits where. The move
//      must go to a VERIFIED-EMPTY cell — that is the whole point of reading the grid before proposing it.
//
//   5. IS THE EDIT BUFFER IN SYNC WITH THE STORED SLOT? `presetRef()` gives the current number; the slot
//      is dumped and decoded and its body is compared with the edit buffer's. If they match, the owner has
//      no unsaved edits and `reloadPreset()` (re-select the slot) is a safe LAST-RESORT undo for the arm.
//      If they differ, that fallback is DESTRUCTIVE and must not be used — the arm's only restore is its
//      own reverse write. Printed explicitly, because getting this wrong loses someone's edit.
//
// NOTHING IS WRITTEN. No cell is moved, no switch is set, no preset is stored. Every frame is a read.
//
// USAGE  npx tsx scripts/probe-grid-baseline.ts [--port /dev/ttyACM0] [--outdir <dir>] [--reads 2]
// Exit: 0 read · 2 an oracle/control was not stable (do NOT build the arm on it) · 3 no device.
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
/** DERIVED mask (probe-2e-volatility + probe-2e-dump-perturbation, 2026-10-12): per-read 22/23/24 plus the
 *  25/26/27 transient a body dump leaves — and this script dumps the body, so the wide mask is the right one. */
const MASK = [22, 23, 24, 25, 26, 27];
const TRIO = [22, 23, 24];
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function longQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, 0x2e, 0x00, 0x00, 0x00, 0x00, 0x00];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}

/** Dump the EDIT BUFFER and return its decompressed body as both hex and bytes (the fn 0x77/0x78/0x79 path). */
async function editBufferBody(session: { transport: { request: (f: number[], o?: { timeoutMs?: number; quietMs?: number; match?: (fs: number[][]) => boolean }) => Promise<number[][]> }; codec: { buildRequestPresetDump: (n: number) => number[] } }): Promise<{ hex: string; len: number }> {
  const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
    timeoutMs: 8000,
    quietMs: 300,
    match: (fs) => fs.some((f) => f[5] === 0x79)
  });
  if (!frames.some((f) => f[5] === 0x79)) throw new Error(`incomplete edit-buffer dump (${frames.length} frames, no 0x79)`);
  const parsed = parsePresetDump(Uint8Array.from(frames.flat()), 0, MODEL);
  const { body } = decodeRawPatch(parsed.chunkPayloads);
  return { hex: Buffer.from(body).toString('hex'), len: body.length };
}

/** Differencing two equal-length hex strings.
 *
 *  `bytes` and `runs` are EXACT: `bytes` is the number of differing bytes and `runs` the maximal runs of
 *  ADJACENT differing bytes. `merged` coalesces runs separated by no more than 8 B, purely to keep a print
 *  short — a merged span may therefore contain bytes that are IDENTICAL, and its length is a SPAN length,
 *  not a count. Report `bytes`/`runs`; use `merged` only for the reading of offsets. (Measured 2026-10-12:
 *  an edit buffer 23 differing bytes in 18 runs away from slot 410 printed as "10 differing region(s)",
 *  because the old single `ranges` field merged over an undisclosed <= 8 B gap and was labelled a count.) */
function diffHex(a: string, b: string): { len: number; bytes: number; runs: [number, number][]; merged: [number, number][] } {
  const n = Math.min(a.length, b.length) / 2;
  const at: number[] = [];
  for (let i = 0; i < n; i++) if (a.slice(i * 2, i * 2 + 2) !== b.slice(i * 2, i * 2 + 2)) at.push(i);
  const group = (gap: number): [number, number][] => {
    const out: [number, number][] = [];
    if (!at.length) return out;
    let s = at[0]!, prev = at[0]!;
    for (const k of at.slice(1)) { if (k - prev > gap) { out.push([s, prev]); s = k; } prev = k; }
    out.push([s, prev]);
    return out;
  };
  return { len: n, bytes: at.length, runs: group(1), merged: group(8) };
}

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const outdir = (arg('--outdir') ?? '/home/insn/repos/stack/review-2026-10-12').replace('~', process.env.HOME ?? '');
  const reads = Math.max(1, Number(arg('--reads') ?? 2));
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;

  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const problems: string[] = [];
  try {
    console.log('══ probe-grid-baseline — READ-ONLY pre-flight for the PLACEMENT arm (H_head) ══');
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);

    // ── 1. standing read ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. standing read ──');
    const sr = await standingRead(session, { note: 'R15 grid-baseline pre-flight' });
    console.log(standingLine(sr));
    console.log(`   hole(${sr.hole?.content ?? '<no reply>'}) · controls: neg 0x99 ${sr.controls.negativeSub99}, status triples ${sr.controls.statusDumpTriples}`);
    if (sr.verdict !== 'read (controls green)') problems.push('standing read controls not green');

    // ── 2. is the independent oracle stable? ────────────────────────────────────────────────────
    console.log('\n── 2. the independent ORACLE (edit-buffer BODY, fn 0x77/0x78/0x79) — two dumps, NOTHING written between ──');
    const d1 = await editBufferBody(session);
    await sleep(400);
    const d2 = await editBufferBody(session);
    const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'hex')).digest('hex').slice(0, 16);
    const dd = diffHex(d1.hex, d2.hex);
    console.log(`   dump A: ${d1.len} B  sha ${sha(d1.hex)}`);
    console.log(`   dump B: ${d2.len} B  sha ${sha(d2.hex)}`);
    if (dd.bytes === 0) {
      console.log('   ORACLE: STABLE — the body reads byte-identical with no write between. It can carry the arm\'s restore proof.');
    } else {
      console.log(`   ORACLE: NOT STABLE — ${dd.bytes} differing byte(s) in ${dd.runs.length} run(s):`);
      for (const [a, b] of dd.runs.slice(0, 12)) console.log(`     body ${a}..${b} (${b - a + 1} B)`);
      problems.push('edit-buffer body is not byte-stable across two reads — it cannot serve as the restore oracle');
    }
    mkdirSync(outdir, { recursive: true });
    writeFileSync(join(outdir, 'placement-baseline-body-a.hex'), d1.hex + '\n');
    writeFileSync(join(outdir, 'placement-baseline-body-b.hex'), d2.hex + '\n');
    console.log(`   wrote ${join(outdir, 'placement-baseline-body-a.hex')} and …-body-b.hex`);

    // ── 3. the grid, two ways ───────────────────────────────────────────────────────────────────
    console.log('\n── 3. the GRID — dump path (fn 0x77) vs the fn=0x01 sub=0x2e reply\'s TAIL ──');
    const g = await session.driver.grid();
    const dumpCells = new Map<string, string>();
    for (const c of g.cells) {
      const k = `${c.row},${c.col}`;
      const d = c.isShunt ? 'shunt' : c.effectId ? `block 0x${c.effectId.toString(16)}` : 'empty';
      dumpCells.set(k, d);
    }
    console.log(`   dump path: ${g.model} “${g.name}” grid ${g.rows}x${g.cols} · ${g.cells.length} cell(s) decode`);
    // THE DUMP PATH IS 0-BASED (parseGen3GridLayout loops row/col from 0); the WRITE contract
    // (`placeCell` / PUT /preset/grid/cell) is 1-BASED. Both are printed so no reader has to guess which
    // base a number is in — a one-cell slip lands a block in the wrong cell.
    console.log('     dump(r,c) 0-based  →  route row/col (1-based, what a write takes):');
    for (let row = 0; row < g.rows; row++) {
      const line: string[] = [];
      for (let col = 0; col < g.cols; col++) line.push((dumpCells.get(`${row},${col}`) ?? 'empty').padEnd(13));
      console.log(`     ${row} (route row ${row + 1}): ${line.join('')}`);
    }

    const longReplies: number[][] = [];
    for (let i = 0; i < reads; i++) {
      const heard = await session.transport.request(longQuery(), { timeoutMs: 1200, quietMs: 80 });
      const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
      if (f) longReplies.push(f);
      await sleep(40);
    }
    console.log(`   sub=0x2e: ${longReplies.length}/${reads} long reply(ies)${longReplies[0] ? ` · ${longReplies[0].length}B` : ''}`);
    if (longReplies.length === reads) {
      const contents = longReplies.map((f) => f.slice(CONTENT_BASE, f.length - 2));
      const minusMask = (c: readonly number[]): string => hex(c.map((b, i) => (MASK.includes(i) ? 0 : b)));
      const stable = new Set(contents.map(minusMask)).size === 1;
      // NOTE the mask is 22..27, not the documented trio 22..24: THIS script dumped the body twice just
      // above, and `probe-2e-dump-perturbation.ts` measured that a body dump transiently moves data 25/26/27
      // for about one 4-read group. Comparing against the trio here would flag our own oracle as drift.
      console.log(`   sub=0x2e stability outside the derived mask ${MASK.join('/')} (trio + the body-dump transient): ${stable ? 'STABLE' : 'DRIFT'}`);
      if (!stable) problems.push(`sub=0x2e reply drifts outside the derived mask ${MASK.join(',')} across reads`);
      const stage = join(outdir, 'placement-baseline-2e.tap');
      writeFileSync(stage, longReplies.map((f) => `${Date.now()} RX ${hex(f)}`).join('\n') + '\n');
      console.log(`   wrote ${stage} (usable as the arm's BEFORE stage)`);
    } else {
      problems.push(`sub=0x2e answered ${longReplies.length}/${reads} reads`);
    }

    // ── 4. empty cells ──────────────────────────────────────────────────────────────────────────
    const empties: string[] = [];
    for (let row = 0; row < g.rows; row++) for (let col = 0; col < g.cols; col++) {
      const d = dumpCells.get(`${row},${col}`);
      if (d === undefined || d === 'empty') empties.push(`route r${row + 1}c${col + 1}`);
    }
    const occupied = [...dumpCells.entries()].filter(([, d]) => d.startsWith('block'));
    console.log(`\n── 4. move targets (ALL coordinates below are the 1-BASED route pair a write takes) ──`);
    console.log(`   occupied block cells: ${occupied.length} → ${occupied.map(([k, d]) => { const [r, c] = k.split(',').map(Number); return `r${r! + 1}c${c! + 1}:${d}`; }).join(' · ')}`);
    console.log(`   EMPTY cells (verified-empty candidates): ${empties.length} → ${empties.join(' ')}`);
    if (empties.length === 0) problems.push('no empty cell to move a block into — the placement arm is not runnable');

    // ── 5. is the edit buffer in sync with the stored slot? ─────────────────────────────────────
    console.log('\n── 5. edit buffer vs the STORED slot (does the reload-last-resort undo exist?) ──');
    const ref = (await session.driver.presetRef?.()) ?? { number: -1, name: '<unavailable>' };
    console.log(`   presetRef: number ${ref.number} · name “${ref.name}”`);
    if (ref.number > 0 && session.driver.backupPreset) {
      try {
        const b = await session.driver.backupPreset(ref.number);
        const stored = parsePresetDump(Uint8Array.from(b.bytes), 0, MODEL);
        const storedBody = decodeRawPatch(stored.chunkPayloads).body;
        const sHex = Buffer.from(storedBody).toString('hex');
        const sd = diffHex(d1.hex, sHex);
        console.log(`   stored slot ${ref.number} “${b.name}”: body ${storedBody.length} B  sha ${sha(sHex)}  vs edit buffer ${d1.len} B`);
        if (sd.bytes === 0) {
          console.log('   IN SYNC — the owner has no unsaved edits; re-selecting the slot is a SAFE last-resort undo.');
        } else {
          console.log(`   NOT IN SYNC — ${sd.bytes} differing byte(s) in ${sd.runs.length} run(s) ⇒ the edit buffer holds UNSAVED EDITS.`);
          console.log('     ⇒ re-selecting/loading the preset would DISCARD them. The arm must restore by its own reverse write and must NOT fall back to a reload.');
          // spans are MERGED over gaps <= 8 B (readable offsets, not a count — `bytes` above is the count).
          for (const [a, bb] of sd.merged.slice(0, 12)) console.log(`       body ${a}..${bb} (span ${bb - a + 1} B; merged, may contain identical bytes)`);
        }
      } catch (e) { console.log(`   stored-slot dump failed: ${(e as Error).message}`); }
    } else {
      console.log('   no preset number / no backup method — cannot tell; treat a reload as DESTRUCTIVE.');
    }

    console.log(`\nVERDICT: ${problems.length === 0 ? 'PRE-FLIGHT GREEN — the arm is buildable on this state' : 'PRE-FLIGHT NOT GREEN'}`);
    for (const p of problems) console.log(`  • ${p}`);
    return problems.length === 0 ? 0 : 2;
  } finally {
    await sleep(50);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
