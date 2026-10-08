// ────────────────────────────────────────────────────────────────────────────────────────────────
// hunt-cab-name — does a capture carry a user-cab NAME, and in which frame?
//
// WHY: FM3-Edit displays user-cab names it reads FROM THE UNIT (proved by writing an unpreknowable name and
// asking a human what the editor showed). The read path is therefore in a capture — but not in any form the
// naive text scan looks for. This searches for the name in every form we can CONSTRUCT: raw ASCII, the 40
// name bytes exactly as the container carries them, fragments, and the per-slot `0x4B` fingerprint. A hit
// names the function byte and sub-action that carries the name; no hit is reported as no hit.
//
// USAGE  npx tsx scripts/hunt-cab-name.ts <capture.pcapng> [container.syx]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readChunks, framesOf } from './scan-usb-capture.js';

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const findAt = (hay: readonly number[], needle: readonly number[]): number => {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
};

/** The 40 name bytes as they sit in the first 0x7B data frame of a cab container. */
export function containerNameField(container: readonly number[]): number[] {
  let s = -1;
  for (let i = 0; i + 5 < container.length; i++) {
    if (container[i] === 0xf0 && container[i + 4] === 0x11 && container[i + 5] === 0x7b) { s = i; break; }
  }
  if (s < 0) return [];
  return container.slice(s + 8, s + 8 + 40);
}

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.log('usage: npx tsx scripts/hunt-cab-name.ts <capture.pcapng> [container.syx]'); return 2; }
  const name = process.env.HUNT_NAME ?? 'LYKOS-NAMETEST';
  const containerPath = argv.filter((a) => !a.startsWith('--'))[1];
  const { chunks } = readChunks(readFileSync(path));
  const { frames } = framesOf(chunks);
  console.log(`${path}: ${frames.length} SysEx frames · hunting "${name}"`);

  const needles: [string, number[]][] = [
    [`ASCII "${name}"`, [...name].map((c) => c.charCodeAt(0))],
    ['ASCII uppercase-lowercase variants are NOT tried (this is a byte hunt, not a fuzzy match)', []],
  ];
  if (containerPath) {
    const field = containerNameField([...readFileSync(containerPath)]);
    if (field.length) {
      console.log(`container name field: ${hex(field)}`);
      needles.push(['container name field (40 B, exact)', field], ['container name field (first 12 B)', field.slice(0, 12)]);
    }
  }
  for (const frag of ['LYKOS', 'NAMETEST', 'AMETEST']) needles.push([`ASCII "${frag}"`, [...frag].map((c) => c.charCodeAt(0))]);

  let any = false;
  for (const [label, needle] of needles) {
    if (!needle.length) continue;
    const hits: { fn: number; sub: number; ep: number; at: number; len: number; bytes: number[] }[] = [];
    for (const f of frames) {
      const at = findAt(f.bytes, needle);
      if (at >= 0) hits.push({ fn: f.fn, sub: f.bytes[6] ?? 0, ep: f.ep, at, len: f.bytes.length, bytes: f.bytes });
    }
    if (hits.length) any = true;
    console.log(`${hits.length ? 'FOUND ' : '  --   '}${label}: ${hits.length} frame(s)`);
    for (const h of hits.slice(0, 8)) {
      console.log(`          fn=0x${h.fn.toString(16)} sub=0x${h.sub.toString(16)} ep=${h.ep} at byte ${h.at} of ${h.len}`);
      console.log(`          ${hex(h.bytes.slice(Math.max(0, h.at - 6), h.at + needle.length + 10))}`);
    }
  }
  console.log(any ? '\nA HIT ABOVE names the carrier — that frame is the name read.' : '\nNO FORM OF THE NAME IS ON THE WIRE in this capture.');
  return any ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
