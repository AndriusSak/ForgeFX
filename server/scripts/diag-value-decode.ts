// THROWAWAY diagnostic: why does decodeReply reject the reply to a self-describe view 0x00 query for
// most params, when the HW-proven matcher finds a correctly-echoed 60-byte frame? Prints the frame, the
// inner fields decodeReply branches on, and the length it requires vs the length it got.
import { openProbeSession } from './probe-device.js';
import { adaptRequest } from '../src/services/deviceCache.js';
import { buildValueQuery, decodeReply } from 'forgefx-midi/cache';

const MODEL = 0x11;
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const septetLen = (n: number) => Math.ceil((n * 8) / 7);

async function main() {
  const opened = await openProbeSession(MODEL);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  try {
    // 70/16 (Delay Low Cut) read as UNREADABLE; 62/33 (Cab Drive) read fine — the control.
    const cases: [number, number, string][] = [
      [70, 16, 'Delay Low Cut — UNREADABLE in the audit'],
      [62, 33, 'Cab Drive — decoded fine in the audit (control)'],
      [66, 32, 'Reverb Drive — read as "0" in the audit'],
    ];
    for (const [eid, pid, label] of cases) {
      const q = buildValueQuery(MODEL, eid, pid);
      const f = await adaptRequest(s.transport, q);
      console.log(`\n=== ${label}  (eid ${eid}, pid ${pid}) ===`);
      console.log(`  query : ${hex(q)}`);
      if (!f) {
        console.log('  no frame returned by adaptRequest');
        continue;
      }
      console.log(`  reply : ${hex(f)}   (${f.length} bytes)`);
      const inner = f.slice(6, f.length - 2);
      const cnt = inner[13] | (inner[14] << 8);
      console.log(
        `  inner : len ${inner.length}  selector(f6)=0x${inner[0].toString(16)}  param(f10)=${inner[4]}  ` +
          `tag(f12)=0x${inner[6].toString(16)}  cnt(f19/20)=${cnt}`
      );
      console.log(`  needs : inner length >= 15 + septetLen(${cnt}) = ${15 + septetLen(cnt)}  ${inner.length >= 15 + septetLen(cnt) ? 'OK' : 'TOO SHORT — decodeReply returns null here'}`);
      const dec = decodeReply(Uint8Array.from(f));
      console.log(`  decode: ${JSON.stringify(dec)}`);
      console.log(`  inner hex: ${hex(inner)}`);
    }
    return 0;
  } finally {
    await s.close();
  }
}

main().then((c) => process.exit(c));
