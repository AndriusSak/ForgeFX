// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-cab-subs — READ-ONLY: dump every implemented per-slot sub-action (fn=0x01, subs 0x4A-0x4E).
//
// WHY: only sub=0x4B (the slot-state query) was mapped. A bounded sweep found that the FM3 also answers
// 0x4A, 0x4C, 0x4D and 0x4E with real data for a given `[index, page]`, and one of them may carry the
// slot's NAME — which would settle §2.5c and make a rename verifiable without a human looking at the
// unit. The oracle for a name decode already exists: U0001's name is KNOWN ("LT TV Mix 7").
//
// NOTHING IS WRITTEN: read-shaped requests only, and the raw reply is printed before any interpretation.
// Run `snapshot-cab-bank.ts save` first and `diff` afterwards — that is the guard against a side effect.
//
// USAGE
//   npx tsx scripts/probe-cab-subs.ts                      # U0001, U0002, an empty slot, scratchpad 1
//   npx tsx scripts/probe-cab-subs.ts --slots 1,12,30,513
//   npx tsx scripts/probe-cab-subs.ts --user 1 --subs 4a,4b,4c,4d,4e
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { cabIrUserSlot, cabIrScratchpad } from 'forgefx-midi/devices/gen3';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const printable = (b: readonly number[]) => b.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');

function query(sub: number, index: number, page: number): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, 0x00, 0x00, 0x00, 0x00, 0x00, index, page, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  return [...body, fractalChecksum(body), 0xf7];
}

export async function main(argv: string[]): Promise<number> {
  let nums = [1, 2, 30, 513];
  let subs = [0x4a, 0x4b, 0x4c, 0x4d, 0x4e];
  let port: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--slots') nums = argv[++i]!.split(',').map(Number);
    else if (a === '--user') nums = [Number(argv[++i])];
    else if (a === '--subs') subs = argv[++i]!.split(',').map((x) => parseInt(x, 16));
    else if (a === '--port') port = argv[++i];
  }
  const opened = await openProbeSession(MODEL, port);
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    console.log(`device ${session.label} · ${nums.length} slot(s) × subs [${subs.map((s) => `0x${s.toString(16)}`).join(' ')}] · READ-ONLY`);
    for (const n of nums) {
      const d = n > 512 ? cabIrScratchpad(n - 512) : cabIrUserSlot(n);
      const label = n > 512 ? `S${String(n - 512).padStart(2, '0')}` : `U${String(n).padStart(4, '0')}`;
      console.log(`\n=== ${label}  [index ${d.index}, page 0x${d.page.toString(16)}] ===`);
      for (const sub of subs) {
        let frames: number[][] = [];
        try {
          frames = await session.transport.request(query(sub, d.index, d.page), { timeoutMs: 700, quietMs: 60 });
        } catch (e) {
          console.log(`  sub 0x${sub.toString(16)}: TRANSPORT ERROR ${(e as Error).message}`);
          continue;
        }
        const r = frames.find((f) => f[5] === 0x01 && f[6] === sub);
        if (!r) { console.log(`  sub 0x${sub.toString(16)}: SILENT`); continue; }
        const pay = r.slice(6, -2);
        console.log(`  sub 0x${sub.toString(16)} (${String(r.length).padStart(2)}B): ${hex(pay.length > 34 ? pay.slice(0, 34) : pay)}${pay.length > 34 ? ' …' : ''}`);
        if (pay.length > 20) console.log(`             ascii ${JSON.stringify(printable(pay).slice(0, 90))}`);
      }
    }
    return 0;
  } finally {
    await session.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
