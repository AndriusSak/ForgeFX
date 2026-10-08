// ────────────────────────────────────────────────────────────────────────────────────────────────
// analyze-cab-capture — point it at a USBPcap/Wireshark capture of FM3-Edit driving the CABINET area
// and it names what is NEW: function bytes and sub-actions that are not in the measured map, and any
// frame carrying readable text (a NAME would look exactly like that).
//
// WHY: two cab questions are capture-gated — how the editor REORDERS user cabs, and whether it can show
// a user-slot NAME (the wire has no slot-data read; probing for one found none). Both are answered by
// the same fixture: a capture of FM3-Edit's Manage Cabs RENAMING a user cab. This tool exists so that
// when the fixture lands, the answer is one command rather than an afternoon — and so that a capture
// taken of the WRONG thing is obvious immediately (all-mapped opcodes = nothing new in it).
//
// WHAT IT PRINTS
//   • frames per endpoint + the fn histogram, with UNMAPPED function bytes called out first;
//   • for fn=0x01, the sub-action histogram, calling out subs outside the measured set;
//   • every frame containing a run of ≥4 printable bytes (fn, sub, and the text) — the name hunt;
//   • frames that carry a cab-slot [index, page] address.
// It INTERPRETS nothing else: unmapped means unmapped, and absence of text is reported as absence, not
// as "the editor shows no names".
//
// USAGE  npx tsx scripts/analyze-cab-capture.ts <capture.pcapng>
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readChunks, framesOf } from './scan-usb-capture.js';
import { CAB_SLOT_FN_SUBACTIONS } from 'forgefx-midi/devices/gen3';

/** The function bytes this stack has MEASURED or captured. Anything else is the interesting part. */
const KNOWN_FNS: Readonly<Record<number, string>> = {
  0x00: 'handshake / identity',
  0x01: 'query — parameter read/write, patch name, cab-slot subs',
  0x08: 'served query',
  0x0d: 'query patch name',
  0x0e: 'served query',
  0x12: 'get cab name — REFUSED by fw 13',
  0x13: 'status dump',
  0x14: 'served query',
  0x1f: 'block bulk read (GET_ALL_PARAMS poll)',
  0x47: 'served query',
  0x52: 'write (continuous variant)',
  0x64: 'multipurpose result — the refusal channel',
  0x74: 'bulk-read burst head',
  0x75: 'bulk-read burst body',
  0x76: 'bulk-read burst end',
  0x77: 'preset dump head',
  0x78: 'preset dump chunk',
  0x79: 'preset dump end — refused as a read on fw 13',
  0x7a: 'cab IR upload — START (carries [index, page])',
  0x7b: 'cab IR upload — DATA chunk',
  0x7c: 'cab IR upload — CLOSE (content checksum)',
  0x7d: 'REFUSED (probed)',
  0x7e: 'REFUSED (probed)',
  0x7f: 'REFUSED (probed)'
};
/** Sub-actions on fn=0x01 this stack has measured. */
const KNOWN_SUBS: Readonly<Record<number, string>> = {
  0x01: 'dead per-pid GET (canned template reply)',
  0x09: 'discrete write',
  0x0d: 'patch-name sub',
  0x1a: 'per-pid range read (the live read path)',
  0x52: 'continuous write',
  ...Object.fromEntries(Object.keys(CAB_SLOT_FN_SUBACTIONS).map((k) => [Number(k), `cab-slot sub — ${CAB_SLOT_FN_SUBACTIONS[Number(k)]!}`]))
};
const hx = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const ascii = (b: readonly number[]) => b.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');

/** The longest run of printable ASCII in a frame — ≥4 is a name-shaped run. */
function longestText(b: readonly number[]): { text: string; at: number } {
  let best = { text: '', at: -1 };
  let cur = '';
  let start = -1;
  for (let i = 0; i < b.length; i++) {
    const ch = b[i]!;
    if (ch >= 0x20 && ch < 0x7f) {
      if (cur === '') start = i;
      cur += String.fromCharCode(ch);
      if (cur.length > best.text.length) best = { text: cur, at: start };
    } else cur = '';
  }
  return best;
}

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.log('usage: npx tsx scripts/analyze-cab-capture.ts <capture.pcapng>'); return 2; }
  const { linktypes, chunks } = readChunks(readFileSync(path));
  const { frames, perEndpoint } = framesOf(chunks);
  console.log(`${path}`);
  console.log(`linktypes ${linktypes.join(', ')} · ${chunks.length} USB chunks · ${frames.length} SysEx frames`);
  console.log(`per endpoint: ${[...perEndpoint].map(([ep, n]) => `${ep}=${n}`).join(' ')}`);
  if (!frames.length) { console.log('NO SysEx FRAMES — is this a USB capture of the FM3 (USBPcap linktype 249 / usbmon)?'); return 3; }

  const byFn = new Map<number, number>();
  const bySub = new Map<number, number>();
  const unmapped: number[][] = [];
  const unmappedSubs: number[][] = [];
  const textFrames: number[][] = [];
  const slotAddressed: number[][] = [];
  for (const f of frames) {
    byFn.set(f.fn, (byFn.get(f.fn) ?? 0) + 1);
    if (!(f.fn in KNOWN_FNS)) unmapped.push(f.bytes);
    if (f.fn === 0x01) {
      const sub = f.bytes[6] ?? -1;
      bySub.set(sub, (bySub.get(sub) ?? 0) + 1);
      if (!(sub in KNOWN_SUBS)) unmappedSubs.push(f.bytes);
    }
    const txt = longestText(f.bytes.filter((x) => x < 0x80));
    if (txt.text.length >= 4) textFrames.push(f.bytes);
    // A cab-slot address: index < 128 and page in the measured cab pages (0x10-0x13 user, 0x20 scratch).
    for (let i = 6; i + 1 < f.bytes.length; i++) {
      const a = f.bytes[i]!; const b = f.bytes[i + 1]!;
      if (a < 128 && ((b >= 0x10 && b <= 0x13) || b === 0x20) && (f.fn === 0x01 || f.fn === 0x7a || a === 0 || a === 1)) {
        slotAddressed.push(f.bytes);
        break;
      }
    }
  }

  console.log(`\nfn histogram (all endpoints):`);
  for (const fn of [...byFn.keys()].sort((a, b) => a - b)) {
    const label = KNOWN_FNS[fn] ?? '*** UNMAPPED ***';
    console.log(`  0x${fn.toString(16).padStart(2, '0')}  ${String(byFn.get(fn)!).padStart(5)}  ${label}`);
  }
  console.log(`\nfn=0x01 sub-action histogram:`);
  for (const sub of [...bySub.keys()].sort((a, b) => a - b)) {
    const label = KNOWN_SUBS[sub] ?? '*** UNMAPPED SUB ***';
    console.log(`  0x${sub.toString(16).padStart(2, '0')}  ${String(bySub.get(sub)!).padStart(5)}  ${label}`);
  }

  const section = (title: string, list: number[][]) => {
    console.log(`\n${title}: ${list.length}`);
    for (const b of list.slice(0, 12)) console.log(`  fn=0x${(b[5] ?? 0).toString(16)} sub=0x${(b[6] ?? 0).toString(16)} ${hx(b.slice(0, 40))}${b.length > 40 ? ' …' : ''}`);
    if (list.length > 12) console.log(`  … and ${list.length - 12} more`);
  };
  section('*** UNMAPPED function bytes — LOOK HERE FIRST ***', unmapped);
  section('*** UNMAPPED fn=0x01 sub-actions — LOOK HERE ***', unmappedSubs);
  section('frames with a readable text run (a NAME would appear here)', textFrames);
  if (textFrames.length) {
    console.log('  (the text in each, with its offset — carry it verbatim, do not "clean" it)');
    for (const b of textFrames.slice(0, 12)) { const t = longestText(b); console.log(`   fn=0x${(b[5] ?? 0).toString(16)} sub=0x${(b[6] ?? 0).toString(16)} @${t.at}: ${JSON.stringify(t.text)}`); }
  }
  section('frames carrying a cab-slot [index, page] address', slotAddressed);

  const nothingNew = unmapped.length === 0 && unmappedSubs.length === 0 && textFrames.length === 0;
  console.log(nothingNew
    ? '\nNOTHING NEW: every function byte and sub-action in this capture is already mapped, and no frame carried readable text. If you meant to capture a rename, the capture does not contain one.'
    : `\nNEW MATERIAL: ${unmapped.length} unmapped fn frame(s), ${unmappedSubs.length} unmapped sub-action frame(s), ${textFrames.length} text-carrying frame(s). These are the candidates to decode.`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
