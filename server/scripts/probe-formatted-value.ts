// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-formatted-value — ask the INSTRUMENT what it displays for a set of parameters.
//
// WHY THIS EXISTS: every oracle this stack owns shares its range tables. The server's runtime profile
// and the HIL harness's raw-bytes oracle both decode with FM3_RANGES / FM3_RANGE_SECTIONS, so a WRONG
// TAPER ROW is invisible to both — they agree with each other while the unit disagrees.
//
// MEASURED 2026-10-13: the owner read 5.00 off the unit for Cab Drive (eid 62, pid 33) at raw 32768
// (exactly mid-scale); our table says `log, min 0.01, max 10` and decodes that same byte to 0.316. His
// earlier read of the same param at raw 0 was 0.00, where our table says 0.01. Both of his numbers fit a
// LINEAR 0..10 mapping; ours do not. The device's own formatted string (self-describe view 0x00) is the
// only automated witness that does not depend on those tables.
//
// READ-ONLY: view 0x00 is the query the read-only walk already uses. No write frames are sent, nothing is
// swept, nothing is restored — this probe cannot change device state.
//
// USAGE
//   npx tsx scripts/probe-formatted-value.ts                          # Cab block, the params that matter
//   npx tsx scripts/probe-formatted-value.ts --eid 58 --pids 7,8,9     # Amp block, gain/bass/mid
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { buildValueQuery, decodeReply, parseDisplayValue } from 'forgefx-midi/cache';

const MODEL = 0x11; // FM3
const DEFAULT_EID = 62; // Cab 1 on the owner's preset 410
/** The params the owner's readings and the server's values disagree about, plus the slice witnesses. */
const DEFAULT_PIDS = [33, 36, 37, 55, 59, 93, 97];
const KNOWN: Record<number, string> = {
  33: 'Drive',
  36: 'Room Size',
  37: 'Mic Spacing',
  55: 'Frequency',
  59: 'Room Diffusion',
  93: 'DynaCab 1 (Position)',
  97: 'Distance 1',
};

export async function main(argv: string[]): Promise<number> {
  const argOf = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const eid = Number(argOf('--eid') ?? DEFAULT_EID);
  const pids = (argOf('--pids') ?? DEFAULT_PIDS.join(','))
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);
  if (!Number.isInteger(eid)) {
    console.log('usage: npx tsx scripts/probe-formatted-value.ts [--eid 62] [--pids 33,36,55]');
    return 2;
  }
  const opened = await openProbeSession(MODEL);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const session = opened.session;
  try {
    console.log(`the INSTRUMENT's own display strings — block eid ${eid}, model 0x${MODEL.toString(16)}`);
    console.log('READ-ONLY (self-describe view 0x00). Compare against what the server serves.\n');
    console.log('pid  name                    device says        parsed');
    console.log('---  ----------------------  -----------------  ---------');
    for (const pid of pids) {
      // A first pass at 1200 ms answered only 2 of 7 params — and a timeout here is indistinguishable from
      // "absent param", which is exactly the truncation hazard the read-only walk is built around
      // (liveWalk.ts: a miss = an absent param). So: a longer window, and one retry before believing a
      // silence.
      const ask = () =>
        session.transport.request(buildValueQuery(MODEL, eid, pid), { timeoutMs: 2500, quietMs: 60 });
      let frames = await ask();
      if (!frames || !frames.length) frames = await ask();
      const last = frames && frames.length ? frames[frames.length - 1] : null;
      // Transport.request returns number[][]; decodeReply wants a Uint8Array (same convention as
      // scripts/probe-cab-name-list.ts).
      const dec = last ? decodeReply(Uint8Array.from(last)) : null;
      const disp = dec && dec.view === 'value' ? dec.value : null;
      const num = disp != null ? parseDisplayValue(disp) : null;
      console.log(
        `${String(pid).padStart(3)}  ${(KNOWN[pid] ?? '').padEnd(22)}  ${(disp ?? '(no reply)').padEnd(17)}  ${
          num === null ? '—' : String(num)
        }`
      );
    }
    return 0;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
