// ────────────────────────────────────────────────────────────────────────────────────────────────
// hunt-perform-page — find the per-preset PERFORMANCE PAGE inside a preset body (§2.2).
//
// WHY: the body decode understands params, modifiers, scenes and blocks — and nothing about perform pages.
// The page is stored per-preset (the editor's left-hand column; the global page lives in system settings and
// is NOT in the body). A page of up to 10 slots must contain REFERENCES to the params it exposes, so this
// decompresses a dumped preset and hunts for the (eid, pid) pairs of known controls — a cluster of hits is
// the page, and its record layout is then readable.
//
// READ-ONLY, offline: it works on a preset dump file, never the device.
//
// USAGE  npx tsx scripts/hunt-perform-page.ts <preset.bin> [--targets 58:12,70:13]
//        (defaults hunt Amp 1 Gain / Delay 1 Mix / Reverb 1 Mix / Reverb 1 Bypass — the controls the owner
//         added to the fixture preset, so the four hits ARE the ground truth)
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parsePresetDump, decodeRawPatch, effectName } from 'forgefx-midi/devices/gen3';
import { PROFILES } from '../src/devices.js';

const hex = (b: ArrayLike<number>, from = 0, n = 32) => Array.from(b).slice(from, from + n).map((x) => x.toString(16).padStart(2, '0')).join(' ');
const paramId = (model: number, family: string, name: string): number | undefined =>
  PROFILES[model]?.params[family]?.find((p) => p.name === name)?.paramId;

export function main(argv: string[]): number {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) { console.log('usage: npx tsx scripts/hunt-perform-page.ts <preset.bin> [--targets eid:pid,...]'); return 2; }
  const MODEL = 0x11;
  const spec = argv.includes('--targets') ? argv[argv.indexOf('--targets') + 1]! : '';
  const targets: { eid: number; pid: number; label: string }[] = [];
  if (spec) {
    for (const t of spec.split(',')) {
      const [e, p] = t.split(':').map(Number);
      targets.push({ eid: e!, pid: p!, label: `${effectName(e!)} pid ${p}` });
    }
  } else {
    // the fixture's controls: the four the owner dragged in (their VALUES do not matter, the POINTERS do)
    const cands: [string, string, string][] = [
      ['amp', 'AMP', 'AMP_GAIN'], ['delay', 'DELAY', 'DELAY_MIX'], ['reverb', 'REVERB', 'REVERB_MIX'], ['reverb', 'REVERB', 'REVERB_BYPASS']
    ];
    const eidFor = (slug: string): number | undefined => PROFILES[MODEL]?.layout?.blocks?.find((b) => b.slug === slug)?.effectId ?? PROFILES[MODEL]?.effects?.find((e) => e.slug === slug)?.effectId;
    for (const [slug, fam, name] of cands) {
      const eid = eidFor(slug); const pid = paramId(MODEL, fam, name);
      if (eid === undefined || pid === undefined) { console.log(`(could not resolve ${fam}/${name} — eid ${eid}, pid ${pid})`); continue; }
      targets.push({ eid, pid, label: `${fam}/${name}` });
    }
  }
  const bytes = new Uint8Array(readFileSync(file.replace('~', process.env.HOME ?? '')));
  const parsed = parsePresetDump(bytes);
  const dec = decodeRawPatch(parsed.chunkPayloads);
  const body = (dec as unknown as { decompressed?: Uint8Array; body?: Uint8Array; rawPatch?: Uint8Array }).decompressed
    ?? (dec as unknown as { body?: Uint8Array }).body
    ?? (dec as unknown as { rawPatch?: Uint8Array }).rawPatch;
  console.log(`file ${file} · dump ${parsed.byteLength} B · modelId 0x${parsed.modelId.toString(16)} · decoded keys: ${Object.keys(dec).join(',')}`);
  if (!body) { console.log('no decompressed body in the decode result — cannot hunt.'); return 1; }
  console.log(`decompressed body: ${body.length} bytes`);
  console.log(`\nhunting ${targets.length} param reference(s): ${targets.map((t) => `${t.label} (eid ${t.eid}, pid ${t.pid})`).join(' · ')}\n`);
  const hits: { t: typeof targets[number]; at: number; width: number }[] = [];
  for (const t of targets) {
    // both plausible encodings: two 7-bit bytes and two raw bytes, either as [eid,pid] or [pid,eid]
    const pats: [number[], number, string][] = [
      [[t.eid & 0x7f, (t.eid >> 7) & 0x7f, t.pid & 0x7f, (t.pid >> 7) & 0x7f], 4, '14-bit eid,pid'],
      [[t.eid, t.pid], 2, 'byte eid,pid'],
      [[t.pid & 0x7f, (t.pid >> 7) & 0x7f, t.eid & 0x7f, (t.eid >> 7) & 0x7f], 4, '14-bit pid,eid'],
      [[t.pid, t.eid], 2, 'byte pid,eid']
    ];
    for (const [pat, width, how] of pats) {
      for (let i = 0; i + width <= body.length; i++) {
        let ok = true;
        for (let k = 0; k < width; k++) if (body[i + k] !== pat[k]) { ok = false; break; }
        if (ok) hits.push({ t, at: i, width });
      }
    }
  }
  if (!hits.length) { console.log('NO hit for any target in any encoding — the references are stored differently (or not in this body).'); return 1; }
  hits.sort((a, b) => a.at - b.at);
  console.log(`${hits.length} hit(s), sorted by offset:`);
  let lastAt = -99;
  for (const h of hits.slice(0, 60)) {
    const gap = h.at - lastAt;
    files: if (gap > 64) console.log(`  ---`);
    console.log(`  @${h.at} ${h.t.label} (${h.width}-byte)   ${hex(body, Math.max(0, h.at - 8), 40)}`);
    lastAt = h.at;
  }
  if (hits.length > 60) console.log(`  … and ${hits.length - 60} more`);
  console.log('\nNOTE: (eid, pid) byte pairs are NOT how the page stores its references. Measured on the fixture:');
  console.log('  the page is a cluster of 16-BIT words plus NUL-terminated 16-bit-character strings, e.g.');
  console.log('  "Amp  GEQ" / "DLY1" / "Gain" / "Mix" / "Off / On", alongside a slot table of 16-bit eids');
  console.log('  (Amp1 58, Delay1 70, Reverb1 66) whose EMPTY slots are zero. Diff the DECOMPRESSED bodies of two');
  console.log('  presets instead (see _reg/_dd in the session notes) — the raw dump diff is useless because the');
  console.log('  body is compressed and a 4-control change reshuffles thousands of packed bytes.');
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
