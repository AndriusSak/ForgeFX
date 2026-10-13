// ────────────────────────────────────────────────────────────────────────────────
// probe-def-block-independence — READ-ONLY: does the VIEW-0x1c definition reply depend on the BLOCK byte?
//
// WHY: the handover's plan for the nibble-5 range rows was "confirm once against the unit's own definition
// record (view 0x1c), which states min/max directly". Before spending a hardware round on that, the query
// itself has to be shown to address a (BLOCK, PARAM) pair at all. This instrument answers that with an
// artifact instead of a reading: it asks the SAME param ids under SEVERAL block bytes and compares the
// decoded records field-by-field.
//
// PREDICTIONS (stated before the run, so the result cannot be rationalised afterwards):
//   • "block selects the family" → the records for one param id differ between blocks 11 (CABINET),
//     13 (DELAY) and 20 (WAH); the per-block sequences disagree almost everywhere.
//   • "block is not part of the address (or is ignored)" → the records are IDENTICAL for every block,
//     differing only in the echoed param/block bytes and the checksum.
// A THIRD outcome is possible and must be reported as its own case: an invalid/fallback block (e.g. 0)
// returning garbage (the codec warns that subnormal floats appear for system selectors).
//
// The artifact is written to --out (JSON) with the raw frames, so the claim is re-checkable by anyone
// (and by `inspect-tap`) without re-running the hardware.
//
// NOTHING IS WRITTEN: view 0x1c reads only.
//
// USAGE  npx tsx scripts/probe-def-block-independence.ts [--blocks 11,13,20,0] [--params 3,4,10,13,16,24]
//                                                        [--out <path.json>]
// ────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { buildDefQuery, decodeReply } from 'forgefx-midi/cache';

const MODEL = 0x11;

/**
 * Is this record unusable — i.e. did the device answer an unmapped/fallback address rather than a param?
 * Measured garbage classes: subnormal floats (`3.0e-41` from block 0), an all-zero slot (id 0, tc 0, every
 * field 0 — the same shape a valid block returns for a param that has no record), absurd scales
 * (-100 / 20000 seen on the same reads), or impossible bounds (max < min).
 */
function unusable(r: DefRecord | null): boolean {
  if (!r) return true;
  if (![r.min, r.max, r.scale, r.def, r.step].every((x) => Number.isFinite(x))) return true;
  if (r.id === 0 && r.tc === 0 && r.scale === 0 && r.min === 0 && r.max === 0 && r.def === 0 && r.step === 0) return true;
  if (Math.abs(r.scale) > 1e4) return true;
  if (r.max < r.min) return true;
  if (r.min !== 0 && Math.abs(r.min) < 1e-30) return true;
  if (Math.abs(r.max) > 1e30) return true;
  return false;
}

export interface DefRecord {
  id: number;
  tc: number;
  min: number;
  max: number;
  scale: number;
  def: number;
  step: number;
}

export async function main(argv: string[]): Promise<number> {
  const argOf = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const blocks = (argOf('--blocks') ?? '11,13,20,0').split(',').map(Number);
  const params = (argOf('--params') ?? '3,4,10,13,16,24').split(',').map(Number);
  const out = argOf('--out') ?? '';

  const opened = await openProbeSession(MODEL);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  const artifact: {
    at: string;
    model: string;
    readOnly: string;
    blocks: number[];
    params: number[];
    raw: Record<string, string[]>;
    records: Record<string, Record<string, DefRecord | null>>;
    sameAcrossBlocks: Record<string, boolean>;
    unusableBlocks?: Record<string, number[]>;
  } = {
    at: new Date().toISOString(),
    model: s.label,
    readOnly: 'view 0x1c definition reads only — no writes, nothing swept',
    blocks,
    params,
    raw: {},
    records: {},
    sameAcrossBlocks: {},
  };

  try {
    console.log(`device: ${s.label} · READ-ONLY (view 0x1c) · blocks ${blocks.join(',')} · params ${params.join(',')}\n`);
    for (const pid of params) {
      const perBlock: Record<string, DefRecord | null> = {};
      const raws: string[] = [];
      for (const blk of blocks) {
        let rec: DefRecord | null = null;
        let raw = '';
        for (let attempt = 0; attempt < 3 && rec == null && !raw; attempt += 1) {
          const frames = await s.transport.request(buildDefQuery(MODEL, blk, pid), { timeoutMs: 900, quietMs: 60 });
          const f = frames.length ? frames[frames.length - 1]! : null;
          if (!f) continue;
          raw = f.map((b) => b.toString(16).padStart(2, '0')).join(' ');
          const dec = decodeReply(Uint8Array.from(f));
          if (dec && dec.view === 'definition') {
            rec = { id: dec.id, tc: dec.tc, min: dec.min, max: dec.max, scale: dec.scale, def: dec.def, step: dec.step };
          }
        }
        perBlock[String(blk)] = rec;
        raws.push(raw || '<no reply>');
      }
      artifact.records[String(pid)] = perBlock;
      artifact.raw[String(pid)] = raws;

      // "Same across blocks" ignores ONLY the two echoed address bytes (frame[8]=block, frame[10]=param)
      // and the trailing checksum, which the device necessarily echoes back differently per query.
      const norm = raws.map((r) => {
        const f = r.split(' ');
        if (f.length < 12) return r;
        const g = [...f];
        g[8] = 'XX'; // block echo
        g[g.length - 2] = 'XX'; // checksum
        return g.join(' ');
      });

      // Compare only the blocks that returned a USABLE record. A block whose record is degenerate or absurd
      // is an unmapped/fallback address, and letting it into the comparison makes the verdict line say
      // "dependent on the block byte" when only that one address misbehaved — measured: block 0 returns
      // subnormal floats (3.0e-41) or an all-zero slot while blocks 11/13/20 agree exactly. The unusable
      // blocks are counted and reported as their own class, never quietly dropped.
      const usableIdx = blocks.map((b, i) => (unusable(perBlock[String(b)]) ? -1 : i)).filter((i) => i >= 0);
      const usableRaw = usableIdx.map((i) => norm[i]!);
      const same = usableIdx.length >= 2 && usableRaw.every((x) => x === usableRaw[0]);
      artifact.sameAcrossBlocks[String(pid)] = same;
      artifact.unusableBlocks ??= {};
      artifact.unusableBlocks[String(pid)] = blocks.filter((b) => unusable(perBlock[String(b)]));

      const recs = blocks.map((b) => perBlock[String(b)]);
      const cmp = recs.some((r) => r)
        ? `id ${recs.map((r) => r?.id ?? '—').join('/')} tc ${recs.map((r) => (r ? '0x' + r.tc.toString(16) : '—')).join('/')} ` +
          `range ${recs.map((r) => (r ? `${r.min}..${r.max} x${r.scale}` : '—')).join('  |  ')}`
        : 'no 36-byte record for ANY block';
      const unus = artifact.unusableBlocks[String(pid)]!;
      console.log(
        `param ${String(pid).padStart(3)}  ${
          usableIdx.length < 2 ? 'NOT COMPARABLE' : same ? 'IDENTICAL across usable blocks' : 'DIFFERS across usable blocks'
        }${unus.length ? ` [unusable block(s): ${unus.join(',')}]` : ''}  ${cmp}`
      );
    }

    const allSame = params.every((p) => artifact.sameAcrossBlocks[String(p)]);
    const anyGarbage = params.some((p) => (artifact.unusableBlocks![String(p)] ?? []).length > 0);
    console.log(`\nverdict: the definition reply is ${allSame ? 'INDEPENDENT of' : 'dependent on'} the block byte, over the usable blocks.`);
    console.log(
      allSame
        ? `So view 0x1c does NOT address a (family, param) pair here — it cannot confirm a per-row display range.${
            anyGarbage ? ' (Block 0 returned garbage records, i.e. that address is unmapped/fallback — it is excluded, not counted as a difference.)' : ''
          }`
        : 'The block byte changes the reply among usable blocks — view 0x1c does address the block, and the rows can be confirmed this way.'
    );
    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), JSON.stringify(artifact, null, 2));
      console.log(`artifact: ${resolve(out)}`);
    }
    return allSame ? 1 : 0;
  } finally {
    await s.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
