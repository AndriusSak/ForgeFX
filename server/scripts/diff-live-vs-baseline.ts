// ────────────────────────────────────────────────────────────────────────────────────────────────
// diff-live-vs-baseline — READ-ONLY. Dump the LIVE edit buffer, and diff it against a CAPTURED body.
//
// WHY: an owner edit made at the unit can only be measured against the state that preceded it, and the
// only trustworthy predecessor is one that was dumped BEFORE the edit and kept. This dumps the current
// edit-buffer BODY (fn 0x77/0x78/0x79 → decodeRawPatch; a different opcode from the `fn=0x01` reads, so it
// is also usable as an independent oracle) and reports every differing byte WITH THE ARRAY IT BELONGS TO.
// The array labelling is not decoration: the per-preset-switch block holds four arrays over one 12-byte
// stride family and a byte at marker+50 is the ACTION-CODE array's slot 24 while the FUNCTION-INDEX array
// starts at marker+52 — reading one array's byte as the other's produced a bogus finding once already.
//
// WHAT IT DOES NOT DO: it writes NOTHING, it never loads or selects a preset, and it never touches a slot.
//
// USAGE  npx tsx scripts/diff-live-vs-baseline.ts --baseline <body.hex> [--slot 410] [--outdir DIR] [--tap PATH]
//   --baseline  a no-space hex body (14476 B) previously written by this tool or by probe-grid-baseline.ts
//   --slot      also dump that stored slot and diff it against the SAME baseline (optional)
// Exit: 0 read · 2 the baseline could not be read/parsed · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { standingRead, standingLine } from './standing-read.js';
import { parsePresetDump, decodeRawPatch } from 'forgefx-midi/devices/gen3';

const MODEL = 0x11;
const EDIT_BUFFER = 0x3fff;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Search for the per-preset-switch marker pair u16 0x05F5 / u16 0x0001. NEVER hard-code the offset: the
 *  body is compressed, so other content shifts it (the doc once recorded "at ~11412" while preset 410's
 *  body holds it at 11420). */
function findMarker(body: number[]): number {
  for (let i = 0; i + 4 < body.length; i++) {
    if (body[i] === 0xf5 && body[i + 1] === 0x05 && body[i + 2] === 0x01 && body[i + 3] === 0x00) return i;
  }
  return -1;
}

/** Name the array a marker-relative offset belongs to. Derived from the model, never carried as a number. */
function labelOffset(rel: number): string {
  const PP = 24;
  // action codes: marker+4 + 2(i-1), u16, over ALL 24 switches
  if (rel >= 4 && rel < 4 + 2 * PP) {
    const i = 1 + Math.floor((rel - 4) / 2);
    const byte = (rel - 4) % 2;
    return `ACTION-CODE array PP#${i} (u16 ${byte === 0 ? 'low' : 'high'} byte)`;
  }
  // function indices: marker+52 + 2(i-1), u16, over ALL 24 switches
  if (rel >= 52 && rel < 52 + 2 * PP) {
    const i = 1 + Math.floor((rel - 52) / 2);
    const byte = (rel - 52) % 2;
    return `FUNCTION-INDEX array PP#${i} (u16 ${byte === 0 ? 'low' : 'high'} byte)`;
  }
  // records: marker+148 + 12(i-1), 12 B each — field n sits at record + 2n
  if (rel >= 148 && rel < 148 + 12 * PP) {
    const r = rel - 148;
    const i = 1 + Math.floor(r / 12);
    const f = r % 12;
    if (f === 0) return `RECORD PP#${i} +0 (the target / record+0 field)`;
    if (f === 1) return `RECORD PP#${i} +1 (odd byte of the +0 u16)`;
    return `RECORD PP#${i} +${f} (field ${f / 2})`;
  }
  if (rel >= 100 && rel < 148) return `switch block GAP marker+${rel} (100..147 — never observed non-zero)`;
  return `outside the switch block (marker${rel >= 0 ? '+' : ''}${rel})`;
}

function hexToBytes(h: string): number[] {
  const t = h.trim();
  if (/\s/.test(t)) return t.split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16));
  const out: number[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16));
  return out;
}

/** Exact differing bytes and their exact runs of ADJACENT differing bytes — never a merged span count. */
function diffExact(a: number[], b: number[]): { at: number[]; runs: [number, number][] } {
  const n = Math.min(a.length, b.length);
  const at: number[] = [];
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) at.push(i);
  const runs: [number, number][] = [];
  if (at.length) {
    let s = at[0]!, prev = at[0]!;
    for (const k of at.slice(1)) { if (k !== prev + 1) { runs.push([s, prev]); s = k; } prev = k; }
    runs.push([s, prev]);
  }
  return { at, runs };
}

async function editBufferBody(session: { transport: { request: (f: number[], o?: { timeoutMs?: number; quietMs?: number; match?: (fs: number[][]) => boolean }) => Promise<number[][]> }; codec: { buildRequestPresetDump: (n: number) => number[] } }): Promise<{ hex: string; len: number; body: number[] }> {
  const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
    timeoutMs: 8000,
    quietMs: 300,
    match: (fs) => fs.some((f) => f[5] === 0x79)
  });
  if (!frames.some((f) => f[5] === 0x79)) throw new Error(`incomplete edit-buffer dump (${frames.length} frames, no 0x79)`);
  const parsed = parsePresetDump(Uint8Array.from(frames.flat()), 0, MODEL);
  const { body } = decodeRawPatch(parsed.chunkPayloads);
  return { hex: Buffer.from(body).toString('hex'), len: body.length, body: Array.from(body) };
}

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const baselinePath = arg('--baseline');
  const outdir = (arg('--outdir') ?? '/home/insn/repos/stack/review-2026-10-12').replace('~', process.env.HOME ?? '');
  const slotNum = arg('--slot') ? Number(arg('--slot')) : undefined;
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  if (!baselinePath) { console.log('usage: npx tsx scripts/diff-live-vs-baseline.ts --baseline <body.hex> [--slot 410] [--outdir DIR]'); return 2; }

  let base: number[];
  try { base = hexToBytes(readFileSync(baselinePath.replace('~', process.env.HOME ?? ''), 'utf8')); }
  catch (e) { console.log(`baseline unreadable: ${(e as Error).message}`); return 2; }
  if (base.length < 1000) { console.log(`baseline is only ${base.length} B — that is not a decoded preset body`); return 2; }

  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const sha = (b: number[]) => createHash('sha256').update(Buffer.from(b)).digest('hex').slice(0, 16);
  try {
    console.log('══ diff-live-vs-baseline — READ-ONLY (nothing written, no preset loaded/selected) ══');
    const sr = await standingRead(session, { note: 'R16 live-vs-baseline' });
    console.log(standingLine(sr));
    console.log(`   hole(${sr.hole?.content ?? '<no reply>'}) · controls: neg 0x99 ${sr.controls.negativeSub99}, status triples ${sr.controls.statusDumpTriples}`);

    const live = await editBufferBody(session);
    await sleep(250);
    mkdirSync(outdir, { recursive: true });
    writeFileSync(join(outdir, 'live-edit-buffer-body.hex'), live.hex + '\n');
    const L = findMarker(live.body);
    const B = findMarker(base);
    console.log(`\nbaseline ${base.length} B sha ${sha(base)} · marker ${B}  (${baselinePath})`);
    console.log(`live     ${live.len} B sha ${sha(live.body)} · marker ${L}   → wrote ${join(outdir, 'live-edit-buffer-body.hex')}`);
    if (L < 0 || B < 0) { console.log('marker not found in one of the bodies — offsets cannot be labelled; stopping'); return 2; }

    const d = diffExact(base, live.body);
    console.log(`\nDIFF: ${d.at.length} differing byte(s) in ${d.runs.length} run(s)  (baseline → live)`);
    if (d.at.length === 0) {
      console.log('   NONE — the live edit buffer is byte-identical to the baseline.');
    } else {
      for (const i of d.at) {
        const rel = i - L;
        console.log(`   body ${i} (marker${rel >= 0 ? '+' : ''}${rel}): ${hex([base[i]!])} → ${hex([live.body[i]!])}   [${labelOffset(rel)}]`);
      }
      console.log('\nper-switch block changes only (marker+0..+439):');
      const sw = d.at.filter((i) => i - L >= 0 && i - L < 440);
      if (!sw.length) console.log('   none — every change is outside the per-preset-switch block');
      for (const i of sw) console.log(`   marker+${i - L}: ${hex([base[i]!])} → ${hex([live.body[i]!])}   [${labelOffset(i - L)}]`);
    }

    if (slotNum !== undefined && session.driver.backupPreset) {
      try {
        const b = await session.driver.backupPreset(slotNum);
        const stored = parsePresetDump(Uint8Array.from(b.bytes), 0, MODEL);
        const sb = Array.from(decodeRawPatch(stored.chunkPayloads).body);
        const ds = diffExact(base, sb);
        console.log(`\nstored slot ${slotNum} “${b.name}” ${sb.length} B sha ${sha(sb)} vs the SAME baseline: ${ds.at.length} differing byte(s) in ${ds.runs.length} run(s)`);
        for (const i of ds.at) {
          const rel = i - findMarker(sb);
          console.log(`   body ${i} (marker${rel >= 0 ? '+' : ''}${rel}): ${hex([base[i]!])} → ${hex([sb[i]!])}   [${labelOffset(rel)}]`);
        }
      } catch (e) { console.log(`slot ${slotNum} dump failed: ${(e as Error).message}`); }
    }
    return 0;
  } catch (e) {
    console.log(`FAILED: ${(e as Error).message}`);
    return 2;
  } finally {
    await sleep(50);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
