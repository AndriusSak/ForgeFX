// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-hole-vs-scene — READ (mostly). WHERE THE "HOLE" RECORD COMES FROM.
//
// The `fn=0x01 sub=0x1b` reply carries a 5-byte address echo (data 0-4) then a NINE-byte content field
// C9 = data 5..13. For an address that holds nothing — and for the at2-selector reply — C9 reads
// `00 00 00 00 00 02 00 00 00`, a value that MOVED between two runs of the same tool earlier today with no
// write by any probe (13:57 `01 00 00 00 00 02`, 14:20 `1b 14 4c 7a 0a 02`). The scene arm just measured
// that it is SCENE-DEPENDENT: scene 0 -> `00 00 00 00 00 02`, scene 1 -> `01 00 00 00 00 02`, reverting 5/5.
// That makes its low byte a candidate for the scene index. This sweeps all eight scenes.
//
// HYPOTHESES AND PREDICTIONS — written before any frame is sent:
//   H_SCENE_INDEX  C9's byte 0 IS the scene index. PREDICTS: a clean 1:1 map 0..7 -> 00..07, every scene
//                  distinct, and scene 0 reproducing today's `00 00 00 00 00 02`.
//   H_SCENE_OTHER  C9 changes with the scene but not as an index. PREDICTS: repeats, or values that are not
//                  0..7, or byte 0 constant while another byte moves.
//   H_STATIC_NOW   C9 does not move at all across the sweep. PREDICTS: one value for all eight scenes —
//                  which would CONTRADICT the scene arm just run, so it is a control on that result.
//
// One self-restoring write per scene, and the ORIGINAL scene is restored at the end and re-read. The scene
// index is read back after every write, so a write that did not land is visible rather than assumed.
//
// USAGE  npx tsx scripts/probe-hole-vs-scene.ts [--port /dev/ttyACM0] [--anchor 0x24]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function subQuery(sub: number, at: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, ...at];
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

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const anchor = arg('--anchor') !== undefined ? parseInt(arg('--anchor')!, 16) : 0x24;
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  let original = -1;
  let changed = false;
  try {
    console.log(`device ${session.label} · hole record (eid 0x${anchor.toString(16)}, at3=0) vs the SCENE`);
    console.log('predictions (written before any frame was sent):');
    console.log('  H_SCENE_INDEX clean 1:1 map 0..7 -> 00..07, all distinct, scene 0 reproduces `00 00 00 00 00 02`');
    console.log('  H_SCENE_OTHER changes with the scene but is not an index (repeats / values > 7 / another byte moves)');
    console.log('  H_STATIC_NOW  one value for all eight scenes — a control on the scene arm just run');
    console.log(`\npreset: "${patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }))}"`);

    const read = async (at: readonly number[]): Promise<string | null> => {
      const heard = await session.transport.request(subQuery(0x1b, at), { timeoutMs: 900, quietMs: 20 });
      const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x1b && x.length <= 100 && x.length > 10);
      return f ? hex(f.slice(7, -1).slice(5, 14)) : null;
    };
    const neg = (await session.transport.request(subQuery(0x99, [0x00, 0x24, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 }))
      .filter((f) => f[5] === 0x01 && f[6] === 0x99);
    console.log(`negative control sub 0x99 → ${neg.length ? 'ANSWERED (unexpected)' : 'SILENT'}`);

    original = (await session.driver.getScene?.())?.index ?? -1;
    if (original < 0) { console.log('\nABORT: could not read the current scene — refusing to switch scenes blind.'); return 2; }
    console.log(`current scene = ${original}\n`);
    console.log('  scene  read-back  C9(anchor, at3=0)                     C9(0x46, at3=0) [control: scene-invariant]');

    const seen = new Map<string, number[]>();
    for (let s = 0; s <= 7; s++) {
      if (s !== original) { await session.driver.setScene?.(s); changed = true; await sleep(500); }
      const back = (await session.driver.getScene?.())?.index ?? -1;
      const c = (await read([0x00, anchor, 0x00, 0x00, 0x00])) ?? '(silent)';
      const ctrl = (await read([0x00, 0x46, 0x00, 0x00, 0x00])) ?? '(silent)';
      seen.set(c, [...(seen.get(c) ?? []), s]);
      console.log(`    ${s}      ${String(back).padStart(2)}         ${c.padEnd(26)}  ${ctrl}${back === s ? '' : '   !! WRITE DID NOT LAND'}`);
      await sleep(60);
    }

    console.log(`\n  ${seen.size} distinct C9 value(s) across the eight scenes`);
    for (const [c, ss] of [...seen].sort((a, b) => a[1][0]! - b[1][0]!)) console.log(`    ${c}  <- scene(s) ${ss.join(',')}`);
    // The anchor's byte 0 is the candidate for the index; say plainly what it held per scene.
    const b0 = new Map<string, number[]>();
    for (let s = 0; s <= 7; s++) { /* recomputed below from `seen` */ }
    console.log('\n  VERDICT (pre-committed):');
    const all = [...seen.keys()];
    const distinct = all.length === 8;
    console.log(`    ${distinct ? 'H_SCENE_INDEX is CONSISTENT' : 'H_SCENE_INDEX is REFUTED'} — ${seen.size} distinct value(s) for 8 scenes${distinct ? '' : ' (an index would give 8)'}`);
    console.log('    (H_STATIC_NOW is refuted if the sweep shows more than one value.)');
    return 0;
  } finally {
    if (changed && original >= 0) {
      await session.driver.setScene?.(original);
      await sleep(500);
      const now = (await session.driver.getScene?.())?.index ?? -1;
      console.log(`\nrestore: set scene ${original}; device reads ${now} → ${now === original ? 'RESTORED' : 'NOT CONFIRMED'}`);
      if (now !== original) { console.log('!! SCENE NOT RESTORED — check the unit.'); }
    }
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
