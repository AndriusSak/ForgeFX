// ────────────────────────────────────────────────────────────────────────────────────────────────
// diff-2e-head-vs-grid — OFFLINE, NO HARDWARE. Answer `H_head` from two or three frame taps.
//
// POSITIVE CONTROL (this tool's fail-ability is the point — a tool that cannot return "nothing changed" is
// worthless). Regenerate the four synthetic taps and run the four commands; the parent session re-ran every
// one of them on 2026-10-12 and all four verdicts fired:
//   npx tsx scripts/make-2e-head-selftest-taps.ts
//   npx tsx scripts/diff-2e-head-vs-grid.ts <scratch>/…-base.tap <scratch>/…-t1.tap <scratch>/…-base.tap  ⇒ per-placement state table
//   npx tsx scripts/diff-2e-head-vs-grid.ts <scratch>/…-base.tap <scratch>/…-t2.tap <scratch>/…-base.tap  ⇒ preset-static metadata
//   npx tsx scripts/diff-2e-head-vs-grid.ts <scratch>/…-base.tap <scratch>/…-t3.tap                      ⇒ volatile / unattributable
//   npx tsx scripts/diff-2e-head-vs-grid.ts <scratch>/…-base.tap <scratch>/…-base.tap                    ⇒ device constant
//
// WRITTEN OFFLINE by a delegated child during ROUND 14 (it never touched the device); reviewed and its four
// verdicts re-run by the parent session before landing here.
//
// H_head (to be RUN later, not here): a `fn=0x01 sub=0x2e` long reply is 590 bytes on the wire.
// Its TAIL is decoded by the repo's own `parseFm3GridLayout` (12x4 grid). Its HEAD — everything
// before the grid region — is 8-byte-periodic and holds ~20 one-hot ladders (`40 20 10 08 04 02 01`).
// When ONE block's state changes (a self-restoring bypass toggle) HOW MANY of the ~44 HEAD records
// change, and do they change LOCK-STEP with exactly one TAIL grid cell?
//
// THIS TOOL does three things on a pair or triple of taps (before / after, or before / during / after,
// in that order) and PRINTS ONE VERDICT LINE:
//   • HEAD : per-8-byte-record diff between stages — how many records differ, WHICH indices, values.
//   • TAIL : which GRID CELL changed, via the repo's REAL `parseFm3GridLayout` (imported, not reimplemented).
//   • VERDICT, implementing the PRE-COMMITTED meanings:
//       exactly 1 head record changing 1:1 with exactly 1 tail cell, reverting in `after`
//                                            ⇒ 'per-placement state table'
//       0 head records changing while a tail cell moves
//                                            ⇒ 'preset-static metadata'
//       a change that does not revert, or a change with no corresponding tail move
//                                            ⇒ 'volatile / unattributable'
//       nothing changed at all               ⇒ 'device constant (nothing changed)'
//
// INDEX CONVENTIONS (which convention each printed number uses):
//   wire    = byte position in the full SysEx frame as captured (F0 at wire 0)
//   mido    = wire - 1   (mido strips the leading F0; this is the PARSER's space)
//   payload = wire - 7   (payload := frame.slice(7,-1), the task's own convention)
//   data    = wire - 12  (reply content := frame.slice(12,-2); the space this repo's own
//             inspect-layout-map.ts / decode-layout-map-matrix.ts measure the "576-byte region",
//             "period 8", "ladders ≡7 mod 8" and "~44 records" in)
//
// The HEAD/TAIL boundary is DERIVED, never hardcoded: FM3_REGION_OFFSET and FM3_BASE_BIT are read
// out of forgefx-midi/src/gen3/axe-fx-iii/gridLayout.ts at runtime, and CROSS-CHECKED against the
// parser's own "frame too short … have N region bytes" error on a synthetic frame. The head length
// (data space) is FM3_REGION_OFFSET - (CONTENT_BASE_WIRE - 1); CONTENT_BASE_WIRE is the frame-envelope
// layout (F0+mfr+model+fn+sub = 7 wire bytes) + the 5-byte address echo the reply returns (ROUND 13).
// The tool ASSERTS the derived tail length equals the parser's required grid region length and warns
// loudly if it does not.
//
// USAGE (from /home/insn/repos/stack/ForgeFX/server):
//   npx tsx <this.ts> <before.tap> <after.tap> [--model 0x11] [--reply last|first|<n>]
//   npx tsx <this.ts> <before.tap> <during.tap> <after.tap> [--model 0x11] [--reply last|first|<n>]
// Exit: 0 = compared, 1 = a stage had no long sub=0x2e reply / bad usage.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

// ── tap parsing (format: `<epoch-millis> TX|RX <hex bytes>`; mirrors scripts/inspect-tap.ts) ──────
interface TapFrame { ts: number; dir: 'TX' | 'RX'; bytes: number[]; line: number }
function parseTap(text: string): TapFrame[] {
  const out: TapFrame[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = /^(\d+)\s+(TX|RX)\s+([0-9a-f ]+)$/i.exec(line);
    if (!m) return;
    out.push({ ts: Number(m[1]), dir: m[2]!.toUpperCase() as 'TX' | 'RX', bytes: m[3]!.trim().split(/\s+/).map((x) => parseInt(x, 16)), line: i + 1 });
  });
  return out;
}
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

// ── locate the repo + the parser + the constants (derived, not hardcoded) ─────────────────────────
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'forgefx-midi', 'src', 'gen3', 'axe-fx-iii', 'gridLayout.ts'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not find forgefx-midi/…/gridLayout.ts walking up from ${process.cwd()} (run from ForgeFX/server)`);
}
function readConst(src: string, name: string): number {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`).exec(src);
  if (!m) throw new Error(`constant ${name} not found in gridLayout.ts`);
  return Number(m[1]);
}

// ── the diff/verdict core ────────────────────────────────────────────────────────────────────────
type Cell = { row: number; col: number; effectId?: number; isShunt: boolean; shuntIndex?: number; cableInputMask: number };
interface Stage {
  path: string; label: string; replyCount: number; repIndex: number | null;
  frame: number[] | null; content: number[] | null; head: number[] | null;
  cells: Cell[] | null; cellKey: Map<string, string> | null;
}
interface HeadChange { index: number; dataLo: number; dataHi: number; before: string; after: string }
interface CellChange { key: string; col: number; row: number; before: string; after: string; kind: 'changed' | 'appeared' | 'vanished' }
interface Delta { head: HeadChange[]; cells: CellChange[] }

const cellDesc = (c: Cell | undefined): string => c === undefined ? '<absent>'
  : c.isShunt ? `shunt#${c.shuntIndex} cable=0x${c.cableInputMask.toString(16)}`
  : `block 0x${c.effectId!.toString(16)} cable=0x${c.cableInputMask.toString(16)}`;

function diff(a: Stage, b: Stage): Delta {
  const head: HeadChange[] = [];
  const A = a.head!, B = b.head!;
  const nrec = Math.floor(Math.min(A.length, B.length) / 8);
  for (let i = 0; i < nrec; i++) {
    const lo = i * 8, hi = lo + 8;
    const va = A.slice(lo, hi), vb = B.slice(lo, hi);
    if (va.join(',') !== vb.join(',')) head.push({ index: i, dataLo: lo, dataHi: hi, before: hex(va), after: hex(vb) });
  }
  const cells: CellChange[] = [];
  const keys = new Set([...a.cellKey!.keys(), ...b.cellKey!.keys()]);
  for (const k of keys) {
    const ca = a.cellKey!.get(k), cb = b.cellKey!.get(k);
    if (ca === cb) continue;
    const [col, row] = k.split(',').map(Number) as [number, number];
    const bc = a.cells!.find((c) => c.col === col && c.row === row);
    const cc = b.cells!.find((c) => c.col === col && c.row === row);
    cells.push({ key: k, col, row, before: cellDesc(bc), after: cellDesc(cc), kind: ca === undefined ? 'appeared' : cb === undefined ? 'vanished' : 'changed' });
  }
  cells.sort((x, y) => x.col - y.col || x.row - y.row);
  return { head, cells };
}

function main(argv: string[]): number {
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--model') && !(i > 0 && argv[i - 1] === '--reply') && !(i > 0 && argv[i - 1] === '--mask'));
  if (files.length < 2 || files.length > 3) { console.log('usage: npx tsx v2-head-diff.ts <before.tap> <after.tap> [--model 0x11] [--reply last|first|<n>]\n   or: npx tsx v2-head-diff.ts <before.tap> <during.tap> <after.tap> [--model 0x11] [--reply last|first|<n>]'); return 1; }
  const model = arg('--model') !== undefined ? parseInt(arg('--model')!, 16) : 0x11;
  // --mask <dataOffsets>: content offsets to IGNORE in every stage, in this tool's `data` space (data = wire-12,
  // i.e. content[i] = frame.slice(12,-2)[i]). It exists for one measured reason: the per-read volatile trio
  // sits at data 22/23/24, which lands INSIDE head records #2 and #3, so a genuine one-record change would be
  // indistinguishable from that known drift. Masking is ZEROING for the comparison only — the output SAYS it
  // masked, and the masked bytes are never reported as unchanged.
  const maskList = (arg('--mask') ?? '').split(',').map((x) => x.trim()).filter((x) => x.length > 0).map((x) => parseInt(x, 10));
  const mask = new Set(maskList.filter((n) => Number.isFinite(n)));
  // --reply accepts ONE selector for all stages, or a COMMA list, one per stage (e.g. --reply 0,63)
  const replySels = (arg('--reply') ?? 'last').split(',');
  const selFor = (i: number) => (replySels[i] ?? replySels[replySels.length - 1] ?? 'last').trim();

  const root = findRepoRoot();
  const gridSrcPath = join(root, 'forgefx-midi', 'src', 'gen3', 'axe-fx-iii', 'gridLayout.ts');
  const parserPath = join(root, 'forgefx-midi', 'src', 'gen3', 'axe-fx-iii', 'index.ts');
  const src = readFileSync(gridSrcPath, 'utf8');
  const FM3_REGION_OFFSET = readConst(src, 'FM3_REGION_OFFSET');
  const FM3_BASE_BIT = readConst(src, 'FM3_BASE_BIT');
  const FM3_GRID_COLS = readConst(src, 'FM3_GRID_COLS');
  const FM3_GRID_ROWS = readConst(src, 'FM3_GRID_ROWS');
  const FM3_COL_STRIDE = readConst(src, 'FM3_COL_STRIDE');
  const FM3_ROW_STRIDE = readConst(src, 'FM3_ROW_STRIDE');

  // envelope constants (the reply FORMAT, documented in test/fixtures/query-subs-decode/README.md)
  const HEADER_WIRE = 7;        // F0 00 01 74 <model> <fn> <sub>
  const ADDRESS_ECHO_WIRE = 5;  // ROUND 13: reply data 0..4 echo the 5-byte address region
  const FOOTER_WIRE = 2;        // checksum + F7
  const CONTENT_BASE_WIRE = HEADER_WIRE + ADDRESS_ECHO_WIRE; // 12

  console.log('════ v2-head-diff — H_head: does a head record move 1:1 with a tail grid cell? ════');
  console.log(`constants (read from ${gridSrcPath.replace(root + '/', '')}):`);
  console.log(`  FM3_REGION_OFFSET=${FM3_REGION_OFFSET}  FM3_BASE_BIT=${FM3_BASE_BIT}  FM3_GRID_COLS=${FM3_GRID_COLS}  FM3_GRID_ROWS=${FM3_GRID_ROWS}  FM3_COL_STRIDE=${FM3_COL_STRIDE}  FM3_ROW_STRIDE=${FM3_ROW_STRIDE}`);
  console.log(`  model byte = 0x${model.toString(16)}${model === 0x11 ? ' (FM3 → parseFm3GridLayout)' : ''}`);

  return import(pathToFileURL(parserPath).href).then((mod: { parseGen3GridLayout: (f: readonly number[], m: number) => Cell[] }) => {
    const { parseGen3GridLayout } = mod;

    // ── cross-check the region offset against the parser's own behaviour ──
    let probedOffset = -1, needed = -1;
    try { parseGen3GridLayout([0xf0, ...new Array(500).fill(0)], 0x11); }
    catch (e) { const m = /have (\d+) region bytes, need (\d+)/.exec((e as Error).message); if (m) { probedOffset = 500 - Number(m[1]); needed = Number(m[2]); } }
    const expectedNeeded = Math.ceil((FM3_BASE_BIT + (FM3_GRID_COLS - 1) * FM3_COL_STRIDE + (FM3_GRID_ROWS - 1) * FM3_ROW_STRIDE + 32) / 7);
    console.log(`parser cross-check: mido.slice(FM3_REGION_OFFSET) ⇒ probed offset ${probedOffset} (source says ${FM3_REGION_OFFSET}); parser needs ${needed} grid-region bytes (derived ${expectedNeeded})${probedOffset === FM3_REGION_OFFSET && needed === expectedNeeded ? '  ✔' : '  ✘ MISMATCH'}`);

    // boundary, DERIVED (mido → wire/payload/data all stated)
    const boundaryMido = FM3_REGION_OFFSET;
    const boundaryWire = boundaryMido + 1;
    const contentBaseMido = CONTENT_BASE_WIRE - 1;
    const headLenData = boundaryMido - contentBaseMido;             // data-space head length
    console.log(`\nHEAD/TAIL boundary (derived from FM3_REGION_OFFSET=${FM3_REGION_OFFSET}, FM3_BASE_BIT=${FM3_BASE_BIT}):`);
    console.log(`  region starts at mido ${boundaryMido} = wire ${boundaryWire} = payload ${boundaryWire - 7} = data ${headLenData}`);
    console.log(`  first grid cell bit = FM3_BASE_BIT (${FM3_BASE_BIT}) within the region; 8-byte head records are anchored at data 0 (the reply content base); 1 head record = data[i*8 .. i*8+8)`);
    console.log(`  head (data) length = ${headLenData}B ⇒ ${Math.floor(headLenData / 8)} full 8-byte HEAD records + ${headLenData % 8} trailing byte(s)`);

    if (mask.size) console.log(`MASK: data offset(s) ${[...mask].sort((a, b) => a - b).join(', ')} are ZEROED in every stage before comparison (they are genuinely volatile), so any change reported below excludes them.`);
    else console.log('MASK: none. If this run toggles anything on a live unit, pass --mask 22,23,24 — the per-read volatile trio sits INSIDE head records #2/#3 and will otherwise read as a spurious one-record change.');

    // ── load stages ──
    const labels = files.length === 3 ? ['before', 'during', 'after'] : ['before', 'after'];
    const stages: Stage[] = files.map((p, i) => {
      const all = parseTap(readFileSync(p, 'utf8'));
      const longs = all.filter((f) => f.dir === 'RX' && f.bytes[5] === 0x01 && f.bytes[6] === 0x2e && f.bytes.length > 100);
      let repIndex: number | null = null;
      const replySel = selFor(i);
      if (longs.length) repIndex = replySel === 'first' ? 0 : replySel === 'last' ? longs.length - 1 : Math.min(Number(replySel), longs.length - 1);
      const frame = repIndex === null ? null : longs[repIndex]!.bytes;
      if (!frame) return { path: p, label: labels[i]!, replyCount: longs.length, repIndex, frame: null, content: null, head: null, cells: null, cellKey: null };
      const content = frame.slice(CONTENT_BASE_WIRE, frame.length - FOOTER_WIRE);
      // Apply --mask for the COMPARISON (zeroing only). Printed values therefore show masked offsets as 00.
      for (const m of mask) if (m >= 0 && m < content.length) content[m] = 0;
      const head = content.slice(0, headLenData);
      let cells: Cell[] = [];
      try { cells = parseGen3GridLayout(frame, model); } catch { cells = []; }
      const cellKey = new Map<string, string>();
      for (const c of cells) cellKey.set(`${c.col},${c.row}`, `${cellDesc(c)}`);
      return { path: p, label: labels[i]!, replyCount: longs.length, repIndex, frame, content, head, cells, cellKey };
    });

    console.log('\nstages:');
    for (const s of stages) console.log(`  ${s.label.padEnd(6)} ${s.path.replace(process.cwd() + '/', '').replace(root + '/', '')}  long-sub=0x2e replies=${s.replyCount}  using ${s.repIndex === null ? '<none>' : '#' + s.repIndex}${s.frame ? `  frame ${s.frame.length}B · content ${s.content!.length}B · ${s.cells!.length} grid cell(s)` : ''}`);

    // consistency: derived head + parser region must sum to the content
    const withRep = stages.filter((s) => s.frame);
    if (withRep.length && needed > 0) {
      const tailLen = withRep[0]!.content!.length - headLenData;
      console.log(`consistency: content ${withRep[0]!.content!.length}B = head ${headLenData}B + tail ${tailLen}B; parser grid needs ${needed}B ${tailLen === needed ? '✔' : '✘ — index mapping is WRONG, do not trust the diff below'}`);
    }

    const missing = stages.filter((s) => !s.frame);
    if (missing.length) {
      for (const s of missing) console.log(`\nSTAGE '${s.label}' (${s.path}): no long sub=0x2e reply in this tap.`);
      console.log('\nVERDICT: cannot compare — a stage holds no long sub=0x2e reply (this is a correct outcome for a tap that');
      console.log('         carries only sub=0x03/0x1b traffic, e.g. a bypass-arm tap).');
      return 1;
    }

    // ── deltas: deviation of each later stage from `before` ──
    const before = stages[0]!;
    const dAfter = diff(before, stages[stages.length - 1]!);
    const dDuring = stages.length === 3 ? diff(before, stages[1]!) : null;

    const headIdx = new Set<number>();
    const cellKeyChanged = new Map<string, CellChange>();
    for (const d of [dDuring, dAfter]) {
      if (!d) continue;
      for (const h of d.head) headIdx.add(h.index);
      for (const c of d.cells) cellKeyChanged.set(c.key, c);
    }
    const headChg = headIdx.size;
    const tailChg = cellKeyChanged.size;
    const sawChange = headChg > 0 || tailChg > 0;
    // PARENT FIX (2026-10-12): the revert test compares the CONTENT (masked as requested), not the raw frame.
    // Raw-frame equality is unreachable whenever a masked offset is genuinely volatile — the per-read trio at
    // data 22-24 differs between any two reads, so `after === before` could never hold and every run would
    // report "did not revert" for that reason alone.
    const reverted = sawChange && stages[stages.length - 1]!.content!.join(',') === before.content!.join(',');

    const showDelta = (name: string, d: Delta) => {
      console.log(`\n── ${name} ──`);
      console.log(`  HEAD records differing: ${d.head.length}`);
      for (const h of d.head) console.log(`    record #${String(h.index).padStart(2)} (data ${h.dataLo}..${h.dataHi - 1}; wire ${h.dataLo + CONTENT_BASE_WIRE}..${h.dataHi - 1 + CONTENT_BASE_WIRE})  before [${h.before}]  after [${h.after}]`);
      console.log(`  TAIL grid cells differing: ${d.cells.length}`);
      for (const c of d.cells) console.log(`    cell (col ${c.col}, row ${c.row})  [${c.kind}]  before ${c.before}  →  after ${c.after}`);
    };
    if (dDuring) showDelta('before → during', dDuring);
    showDelta(`before → ${stages[stages.length - 1]!.label}`, dAfter);

    // ── verdict ──
    const reason = (() => {
      if (!sawChange) return 'no head record and no tail cell differs between any stage';
      if (headChg === 0 && tailChg > 0) return `${tailChg} tail cell(s) moved while 0 of the head records moved`;
      if (headChg === 1 && tailChg === 1 && reverted) return 'one head record and one tail cell moved together and the after stage is byte-identical to before';
      if (headChg > 0 && tailChg === 0) return `${headChg} head record(s) moved but no tail cell moved (change with no corresponding tail move)`;
      if (!reverted) return `change(s) present (head=${headChg}, tail=${tailChg}) did not revert: after ≠ before`;
      return `head=${headChg}, tail=${tailChg} — not a 1:1 locked pair`;
    })();
    const verdict = !sawChange ? 'device constant (nothing changed)'
      : headChg === 0 && tailChg > 0 ? 'preset-static metadata'
      : headChg === 1 && tailChg === 1 && reverted ? 'per-placement state table'
      : 'volatile / unattributable';

    // `reverted` is only meaningful when something changed — printing "false" for a no-change run reads as
    // "a change did not revert", which is the opposite of what happened. Say n/a explicitly.
    console.log(`\nsummary: head records changed=${headChg} (of ${Math.floor(headLenData / 8)}) · tail cells changed=${tailChg} · reverted(after==before)=${sawChange ? String(reverted) : 'n/a (nothing changed)'}`);
    console.log(`VERDICT: ${verdict} — ${reason}`);
    return 0;
  }).catch((e: unknown) => { console.log(`ERROR: ${(e as Error).message}`); return 1; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) Promise.resolve(main(process.argv.slice(2))).then((c) => process.exit(c));
