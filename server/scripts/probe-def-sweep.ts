// ────────────────────────────────────────────────────────────────────────────────
// probe-def-sweep — READ-ONLY: sweep a family's param ids, read each one's DEFINITION record (view 0x1c),
// and ask ONE question: does the device's record at index k correspond to OUR table's row at index k?
//
// WHY (measured 2026-10-13, immediately before this script was written):
//   `probe-def-ranges.ts` asked for the definition of every typecode-nibble-5 range row plus controls.
//   ONE control agreed perfectly — ROTARY/13, our row tc=0x0043 0.1..10 x1, the unit's record tc=0x43
//   min 0.1 max 10 scale 1 — so the query is correctly addressed and the 36-byte layout
//   (u32 id, u32 tc, f32 min, f32 max, f32 scale, f32 def, f32 step) is right.
//   Everywhere else the two sides disagreed, and the device's returned typecode almost never equalled
//   ours (WAH/3 ours 0x52 vs 0x531; DELAY/16 ours 0x241 vs 0x10; FUZZ/8 ours 0x242 vs 0x10). Several
//   replies were non-physical (min 0, max 0, scale -100 / 20000) and ten were a payloadless echo.
//   Two explanations fit: (a) our param INDEX for a family is offset from the device's, or (b) the
//   definition record is not a per-param display range at all. This script separates them.
//
// WHAT IT PRINTS: one line per swept param (device record + our row), then a MATCH COUNT for every shift
// in [-3..+3] over the swept window, where a "match" means the device's typecode equals our row's typecode
// at that shift. Explanation (a) predicts a single shift that matches most params; explanation (b)
// predicts no shift does. A shift is only evidence if the match count is high AND ONE-SIDED — with a
// handful of distinct typecodes in a family, chance agreement is real, so the count is reported with the
// number of comparable params and the runner-up, never as a bare "match".
//
// NOTHING IS WRITTEN: view 0x1c reads only.
//
// USAGE  npx tsx scripts/probe-def-sweep.ts --family WAH [--block 20] [--lo 0] [--hi 28]
// ────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { buildDefQuery, decodeReply } from 'forgefx-midi/cache';
import { FM3_RANGES, FM3_RANGE_SECTIONS, fm3EffectId } from 'forgefx-midi/gen3/fm3';

const MODEL = 0x11;

const f = (x: number) => (Number.isFinite(x) ? String(Number(x.toPrecision(6))) : String(x));

interface DevRow {
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
  const family = argOf('--family') ?? 'WAH';
  const meta = FM3_RANGE_SECTIONS[family];
  if (!meta) {
    console.log(`unknown family ${family} — known: ${Object.keys(FM3_RANGE_SECTIONS).join(', ')}`);
    return 2;
  }
  // The fn-0x01 block byte is the EFFECT ID, never the cache section tag (assign.ts; measured 2026-10-13:
  // section tags 11/13/20 are UNASSIGNED effect ids and every one of them answers from a shared fallback
  // table, which made three different families look byte-identical). `meta.sectionTag` is the cache-side
  // tag and must not be sent.
  const block = argOf('--block') ? Number(argOf('--block')) : (fm3EffectId(family, 1) ?? meta.sectionTag);
  const lo = argOf('--lo') ? Number(argOf('--lo')) : 0;
  const hi = argOf('--hi') ? Number(argOf('--hi')) : 28;

  const opened = await openProbeSession(MODEL);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  const dev = new Map<number, DevRow | null>();
  try {
    console.log(`device: ${s.label} · READ-ONLY (view 0x1c) · family ${family} block ${block} params ${lo}..${hi}\n`);
    console.log('pid  DEVICE  tc      min..max (xscale)                 |  OURS  tc      min..max (xscale)');
    console.log('---  ------  ------  --------------------------------  |  ----  ------  ------------------');
    for (let pid = lo; pid <= hi; pid += 1) {
      let row: DevRow | null = null;
      for (let attempt = 0; attempt < 3 && row == null; attempt += 1) {
        const frames = await s.transport.request(buildDefQuery(MODEL, block, pid), { timeoutMs: 900, quietMs: 60 });
        const dec = frames.length ? decodeReply(Uint8Array.from(frames[frames.length - 1]!)) : null;
        if (dec && dec.view === 'definition') {
          row = { id: dec.id, tc: dec.tc, min: dec.min, max: dec.max, scale: dec.scale, def: dec.def, step: dec.step };
        } else if (dec != null) {
          break; // a real reply of another kind — do not re-ask
        }
      }
      dev.set(pid, row);
      const ours = FM3_RANGES[family]?.[pid];
      const devStr = row
        ? `${row.id ? 'rec' : 'ZERO'}  0x${row.tc.toString(16).padStart(4, '0')}  ${`${f(row.min)}..${f(row.max)} x${f(row.scale)}`.padEnd(32)}`
        : `${'none '}  ${'—'.padEnd(4)}  ${'NO 36-BYTE RECORD (payloadless echo)'.padEnd(32)}`;
      const ourStr = ours ? `0x${ours.typecode.toString(16).padStart(4, '0')}  ${f(ours.displayMin)}..${f(ours.displayMax)} x${f(ours.scale)}` : '— (no row)';
      console.log(`${String(pid).padStart(3)}  ${devStr}  |  ${ours ? 'row ' : '----'}  ${ourStr}`);
    }

    // ── Alignment test: for each shift, how many swept params have device-tc == our-tc at that shift? ──
    console.log('\n── ALIGNMENT (device typecode at index k vs our typecode at index k+shift) ──');
    const shifts: { shift: number; same: number; comparable: number }[] = [];
    for (let shift = -3; shift <= 3; shift += 1) {
      let same = 0;
      let comparable = 0;
      for (const [pid, row] of dev) {
        if (!row) continue;
        const ours = FM3_RANGES[family]?.[pid + shift];
        if (!ours) continue;
        comparable += 1;
        if (ours.typecode === row.tc) same += 1;
      }
      shifts.push({ shift, same, comparable });
    }
    for (const { shift, same, comparable } of shifts) {
      console.log(`  shift ${String(shift).padStart(2)}: ${same}/${comparable} typecodes agree`);
    }
    const best = [...shifts].sort((a, b) => b.same - a.same)[0];
    const runnerUp = [...shifts].sort((a, b) => b.same - a.same)[1];
    console.log(
      `\nbest shift ${best.shift} (${best.same}/${best.comparable}); runner-up shift ${runnerUp.shift} (${runnerUp.same}/${runnerUp.comparable}).`
    );
    if (best.same <= runnerUp.same + 1) {
      console.log('No single shift stands out — the misalignment hypothesis is NOT supported by this sweep.');
    }
    return 0;
  } finally {
    await s.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
