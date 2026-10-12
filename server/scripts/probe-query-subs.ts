// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-query-subs — READ-ONLY: ask the unit about the THREE `fn=0x01` sub-actions this stack's docs call
// UNMAPPED (`0x03`, `0x1b`, `0x2e`), plus two controls.
//
// WHY: `Axis/docs/NEXT-STEPS.md` lists them as "unmapped, surfaced by the capture analyser", and
// `review`-level work has treated them as capture-gated. They are NOT: the upstream gen-3 codec
// (`forgefx-midi/src/devices/gen3/simResponders.ts`) carries a per-sub-action RESPONSE-LENGTH table derived
// from the FM9 connect+enum-sweep capture (2026-06-03), and two of the three are NAMED there already:
//
//     0x2e  SUB_LAYOUT_MAP    expected reply 755 bytes
//     0x1b  SUB_PARAM_FLAGS   expected reply  23 bytes
//     0x03  (no entry at all — no captured REPLY, which is itself the hypothesis below)
//
// So each sub gets a falsifiable prediction, stated here BEFORE the probe runs:
//
//   sub 0x2e → a LONG reply (≈755 bytes upstream; the FM3's own geometry may differ, so the prediction is
//              "hundreds of bytes, table-shaped", not the exact number)
//   sub 0x1b → a SHORT reply of 23 bytes
//   sub 0x03 → either NO reply at all (i.e. it is WRITE-shaped, which is why 2786 frames of it appear in a
//              capture with no reply length recorded) or a short reply; anything in between is a surprise
//   sub 0x4b → the POSITIVE CONTROL: the cab-slot state query, known to answer 60 bytes for a valid
//              `[index, page]`. A probe that cannot reproduce the known one cannot be trusted about the others.
//   sub 0x99 → the NEGATIVE CONTROL: an unmapped sub. Expect a `0x64` refusal or silence, NOT data.
//
// NOTHING IS WRITTEN. Every frame is read-shaped (fn=0x01 with no value bytes), a frame tap is written, and the
// preset name is read before and after so a side effect would show up. Payload SHAPES are swept deliberately,
// because the sub-action is a payload byte: with fn=0x01 known-good the device parses these instead of refusing
// them at the function byte, which is exactly the difference from the old "probing cannot find an opcode" rule.
//
// USAGE  npx tsx scripts/probe-query-subs.ts [--port /dev/ttyACM0] [--subs 03,1b,2e] [--variants zeros,placed]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const printable = (b: readonly number[]) => b.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');

/**
 * The address region, i.e. query bytes 7..11 — the 5 bytes every fn=0x01 response ECHOES back (the echo-of-5..11
 * invariant is documented in the codec). Variants differ only here, so a shape that answers can be told from one
 * that does not without changing anything else.
 */
const VARIANTS: Readonly<Record<string, readonly number[]>> = {
  zeros: [0x00, 0x00, 0x00, 0x00, 0x00],
  // The shape the capture shows for 0x03: "... 01 03 01 3a ..." — byte 7 = 0x01, byte 8 = 0x3a = eid 58 (AMP).
  placed: [0x01, 0x3a, 0x00, 0x00, 0x00],
  // The same eid with a zero lead byte — separates "0x01 is a flag" from "0x3a is the address".
  amp: [0x00, 0x3a, 0x00, 0x00, 0x00],
};

function query(sub: number, at: readonly number[], padTo = 20): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, ...at];
  while (body.length < padTo) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}

/** fn=0x0D QUERY PATCH NAME (current preset) — the cheap "has anything changed" oracle for a read-only probe. */
function patchNameQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x0d, 0x7f, 0x7f];
  return [...body, fractalChecksum(body), 0xf7];
}

/** The printable run in a fn=0x0D reply — the preset name, or '' when the reply carries none. */
function patchNameOf(frames: readonly number[][]): string {
  const f = frames.find((x) => x[5] === 0x0d);
  if (!f) return '<no reply>';
  const body = f.slice(6, -2).filter((b) => b >= 0x20 && b < 0x7f);
  return String.fromCharCode(...body).trim();
}

export async function main(argv: string[]): Promise<number> {
  let subs = [0x03, 0x1b, 0x2e, 0x4b, 0x99];
  let variantNames = ['zeros', 'placed', 'amp'];
  let port: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--subs') subs = argv[++i]!.split(',').map((x) => parseInt(x, 16));
    else if (a === '--variants') variantNames = argv[++i]!.split(',');
    else if (a === '--port') port = argv[++i];
  }

  const opened = await openProbeSession(MODEL, port);
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    console.log(`device ${session.label} · READ-ONLY · ${subs.length} sub(s) × ${variantNames.length} shape(s)`);
    // The claim "nothing changed" is only worth something if it is CHECKED: the preset name is read before and
    // after, and a difference aborts the run with a loud line rather than a quiet success.
    const nameBefore = patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }));
    console.log(`preset name before: ${JSON.stringify(nameBefore)}`);
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);
    console.log('predictions (written before any frame was sent):');
    console.log('  0x2e → a LONG, table-shaped reply (upstream expects 755B)');
    console.log('  0x1b → a 23-byte reply');
    console.log('  0x03 → no reply (write-shaped) or a short one — 2786 frames of it were captured with no reply length');
    console.log('  0x4b → POSITIVE CONTROL: 60 bytes for a valid [index, page]');
    console.log('  0x99 → NEGATIVE CONTROL: a 0x64 refusal or silence, never data\n');

    for (const sub of subs) {
      const isCabSub = sub === 0x4b;              // the control needs the [index, page] pair at bytes 12..13
      console.log(`=== sub 0x${sub.toString(16).padStart(2, '0')} ${isCabSub ? '(POSITIVE CONTROL)' : sub === 0x99 ? '(NEGATIVE CONTROL)' : ''} ===`);
      for (const vn of variantNames) {
        const at = [...VARIANTS[vn]!];
        const frame = isCabSub
          // U0001's [index, page] — a slot the stack has read successfully before.
          ? queryWithCabAddress(sub, 1, 0x10)
          : query(sub, at);
        let heard: number[][] = [];
        try {
          heard = await session.transport.request(frame, { timeoutMs: 900, quietMs: 60 });
        } catch (e) {
          console.log(`  [${vn}] TRANSPORT ERROR ${(e as Error).message}`);
          continue;
        }
        // Pair on the ECHOED SUB, never on adjacency: a fn=0x01 reply may not sit next to its request.
        const mine = heard.filter((f) => f[5] === 0x01 && f[6] === sub);
        const nacks = heard.filter((f) => f[5] === 0x64);
        const other = heard.filter((f) => !(f[5] === 0x01 && f[6] === sub) && f[5] !== 0x64);
        const desc = mine.length
          ? `ANSWERED ${mine.map((f) => `${f.length}B`).join('/')} → ${hex(mine[0]!.slice(6, 26))}${mine[0]!.length > 28 ? ' …' : ''}`
          : nacks.length ? `REFUSED (0x64 ×${nacks.length})` : 'SILENT';
        console.log(`  [${vn}] sent ${hex(frame.slice(5, 14))} … ${frame.length}B → ${desc}`);
        if (mine.length && mine[0]!.length > 40) console.log(`        ascii ${JSON.stringify(printable(mine[0]!.slice(6, 120)))}`);
        if (other.length) console.log(`        (+${other.length} other frame(s): ${other.map((f) => `fn 0x${(f[5] ?? 0).toString(16)} ${f.length}B`).join(', ')})`);
      }
    }
    const nameAfter = patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }));
    console.log(`preset name after:  ${JSON.stringify(nameAfter)}`);
    if (nameAfter !== nameBefore) {
      console.log('!! THE PRESET NAME CHANGED DURING A READ-ONLY PROBE — a side effect happened. Investigate before trusting any reading above.');
      return 4;
    }
    console.log('side-effect check: preset name identical before and after.');
    return 0;
  } finally {
    await session.close();
  }
}

/** The cab-slot shape (bytes 12..13 = index, page), used only for the positive control. */
function queryWithCabAddress(sub: number, index: number, page: number): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, 0x00, 0x00, 0x00, 0x00, 0x00, index, page, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  return [...body, fractalChecksum(body), 0xf7];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
