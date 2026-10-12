// ────────────────────────────────────────────────────────────────────────────────────────────────
// decode-preset-knobs — OFFLINE, no device. Decode a preset BODY with the SHIPPED decoder and report
// what a client would show for every block param, flagging values at MID-SCALE.
//
// WHY. The owner reported "some knobs show 50% while the unit says 0%". A knob can only render 50% from
// a raw at mid-scale (32767 of the 0..65534 model) or from a display value at the middle of its range, so
// this lists every param whose RAW is mid-scale — the population any such report must come from — and
// prints each block's decoded params so a wrong value can be compared against the unit's own screen.
// It is the offline half of the check: the FM3 itself may be on another host, and the body it serves is
// the same bytes this reads.
//
// USAGE
//   npx tsx scripts/decode-preset-knobs.ts --body <file.hex>            # a tools/bodies/*.hex fixture
//   npx tsx scripts/decode-preset-knobs.ts --body <file.hex> --eid 0x46 --all
//   npx tsx scripts/decode-preset-knobs.ts --bin <preset-410-*.bin>     # a raw dump, decoded in place
// The .hex form is `marker N` + one hex line (what tools/decode-one.ts writes); --eid prints one block in
// full; without it every block is summarised and every mid-scale param is named.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readBlockParamsForModel, slugForEffectId, effectName, parsePresetDump, decodeRawPatch } from 'forgefx-midi/devices/gen3';

const MID = 32767;
const MID_TOL = 1;

function bodyFromHexFile(path: string): { body: Uint8Array; note: string } {
  const text = readFileSync(path, 'utf8');
  const lines = text.trim().split('\n');
  const hexLine = lines.find((l) => /^[0-9a-fA-F\s]+$/.test(l) && l.trim().length > 100);
  if (!hexLine) throw new Error(`${path}: no hex body line found (expected 'marker N' then one hex line)`);
  const marker = /^marker (\d+)/.exec(lines[0] ?? '');
  return { body: Uint8Array.from(Buffer.from(hexLine.trim(), 'hex')), note: marker ? `marker ${marker[1]}` : 'no marker line' };
}

function bodyFromBin(path: string): { body: Uint8Array; note: string; placed: number[] } {
  const bytes = new Uint8Array(readFileSync(path));
  const { body } = decodeRawPatch(parsePresetDump(bytes, 0, 0x11).chunkPayloads);
  // The placed set can come from the GRID region of a 0x2e reply only; a .bin carries no such region, so
  // take the eids the body's own block headers declare (what the decoder walks anyway).
  const placed: number[] = [];
  for (let eid = 0; eid < 256; eid++) placed.push(eid);   // the decoder filters by header presence
  return { body, note: 'decoded from .bin', placed };
}

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const hexPath = arg('--body');
  const binPath = arg('--bin');
  if (!hexPath && !binPath) { console.log('usage: --body <file.hex> | --bin <file.bin> [--eid 0x46] [--all]'); return 2; }
  const onlyEid = arg('--eid') !== undefined ? parseInt(arg('--eid')!, 16) : null;
  const all = argv.includes('--all');

  const { body, note } = hexPath ? bodyFromHexFile(hexPath) : bodyFromBin(binPath!);
  const eids = [0x25, 0x2a, 0x2b, 0x2e, 0x3a, 0x3e, 0x42, 0x46, 0x4e, 0x52, 0x5a, 0x5e, 0x76];
  console.log(`body ${body.length} B (${note}) · decoding with the SHIPPED model`);
  const blocks = readBlockParamsForModel(body, new Set(eids), 0x11) as unknown as Record<string, unknown>[];
  console.log(`blocks: ${blocks.length}\n`);

  let totalParams = 0, midParams = 0;
  const uncalibrated: { eid: number; slug: string; name: string; pid: number; raw: number }[] = [];
  for (const b of blocks) {
    const eid = Number(b.effectId ?? b.eid ?? -1);
    if (onlyEid !== null && eid !== onlyEid) continue;
    const slug = slugForEffectId(eid) ?? '';
    const params = (b.params ?? b.named ?? []) as Record<string, unknown>[];
    const mids: string[] = [];
    for (const p of params) {
      totalParams++;
      const raw = typeof p.raw === 'number' ? p.raw : (typeof p.valueRaw === 'number' ? p.valueRaw : null);
      const val = typeof p.value === 'number' ? p.value : null;
      if (raw !== null && Math.abs(raw - MID) <= MID_TOL) mids.push(`${p.name ?? p.paramId}${p.paramId !== undefined ? `(pid ${p.paramId})` : ''}`);
      // A param whose served `value` IS its raw 16-bit integer has no display calibration: the reader
      // passes the raw through. Those are the params a UI can only render as a POSITION, so they are the
      // population a "50% while the unit says 0" report most plausibly comes from.
      if (raw !== null && val !== null && raw === val && raw > 100) {
        uncalibrated.push({ eid, slug, name: String(p.name ?? p.paramId), pid: Number(p.paramId ?? -1), raw });
      }
    }
    midParams += mids.length;
    console.log(`0x${eid.toString(16).padStart(2, '0')} ${(slug || effectName(eid) || '').padEnd(9)} ${String(params.length).padStart(4)} params · mid-scale RAWs: ${mids.length}${mids.length ? ' → ' + mids.slice(0, 14).join(', ') + (mids.length > 14 ? ` … +${mids.length - 14}` : '') : ''}`);
    if (all && (onlyEid === null || eid === onlyEid)) {
      for (const p of params.slice(0, 40)) {
        const raw = typeof p.raw === 'number' ? p.raw : null;
        const val = typeof p.value === 'number' ? p.value : (typeof p.value === 'string' ? p.value : '');
        const flag = raw !== null && Math.abs(raw - MID) <= MID_TOL ? '  <-- 50% of the 0..65534 model' : '';
        console.log(`      ${String(p.name ?? p.paramId).padEnd(26)} raw=${raw === null ? '—' : String(raw).padStart(5)} value=${String(val).padStart(10)}${flag}`);
      }
    }
  }
  console.log(`\nTOTAL ${totalParams} params · ${midParams} at mid-scale (raw 32767±1)`);
  console.log(`UNCALIBRATED (served value == raw 16-bit integer, so a UI can only show a POSITION): ${uncalibrated.length}`);
  const byBlock = new Map<string, string[]>();
  for (const u of uncalibrated) {
    const k = `0x${u.eid.toString(16).padStart(2, '0')} ${u.slug}`;
    byBlock.set(k, [...(byBlock.get(k) ?? []), `${u.name}${u.raw === MID ? '(50%)' : u.raw === 65534 ? '(100%)' : `(${u.raw})`}`]);
  }
  for (const [k, v] of byBlock) console.log(`  ${k.padEnd(14)} ${v.length} → ${v.slice(0, 16).join(', ')}${v.length > 16 ? ` … +${v.length - 16}` : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) Promise.resolve(main(process.argv.slice(2))).then((c) => process.exit(c));
