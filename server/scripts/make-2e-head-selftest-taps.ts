// make-2e-head-selftest-taps — writes SYNTHETIC taps under the scratch dir that each force ONE verdict out of
// `diff-2e-head-vs-grid.ts`, which is the positive control for that tool: a verdict tool that cannot return
// "nothing changed" is worthless. No hardware, no repo files touched. Frames are built byte-exact in the reply
// envelope this repo documents, with the grid region (mido 366) carrying a hand-placed 12x4 grid so
// the REAL parseFm3GridLayout decodes it.
//
//   base   : head {ladder at data 7..13, everything else 0}, grid cells A
//   t1     : head data[0] 00→02 (ONE 8-byte record) AND amp cell cable 0→1  (during, reverting)
//   t2     : head unchanged                              AND amp cell cable 0→1  (during, reverting)
//   t3     : head data[0] 00→02 (ONE record)             AND amp cell cable 0→1  (after, NOT reverting)
//
//   TEST 1  base t1 base  ⇒ per-placement state table
//   TEST 2  base t2 base  ⇒ preset-static metadata
//   TEST 3  base t3       ⇒ volatile / unattributable
//   TEST 4  base base     ⇒ device constant (nothing changed)
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FOOTER = 2, HEADER = 7, ADDR = 5, CONTENT = 576, HEADLEN = 355;
const BASE_BIT = 6, COL_STRIDE = 128, ROW_STRIDE = 32, TYPE_SHUNT = 0x40;

function writeBits7(region: number[], bit: number, n: number, value: number): void {
  for (let i = 0; i < n; i++) {
    const b = bit + i, byte = Math.floor(b / 7), pos = 6 - (b % 7);
    const v = (value >>> (n - 1 - i)) & 1;
    region[byte] = ((region[byte] ?? 0) & ~(1 << pos)) | (v << pos);
  }
}
function writeCell(region: number[], col: number, row: number, id: number, type: number, cable: number): void {
  writeBits7(region, BASE_BIT + col * COL_STRIDE + row * ROW_STRIDE, 32, ((id & 0xfff) << 20) | ((type & 0xff) << 8) | (cable & 0xff));
}
function makeFrame(headEdits: Record<number, number>, ampCable: number): number[] {
  const content = new Array<number>(CONTENT).fill(0);
  for (let i = 0; i < 7; i++) content[7 + i] = [0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01][i]!; // one ladder at data 7..13
  const region = content.slice(HEADLEN); // length 221
  writeCell(region, 0, 0, 58, 0x00, 0x00);          // amp  (col0,row0)
  writeCell(region, 1, 0, 62, 0x00, 0x00);          // cab  (col1,row0)
  writeCell(region, 2, 0, 1, TYPE_SHUNT, 0x00);     // shunt(col2,row0)
  writeCell(region, 0, 0, 58, 0x00, ampCable);      // amp cable (re-writes the amp cell)
  for (let i = 0; i < region.length; i++) content[HEADLEN + i] = region[i]!;
  for (const [k, v] of Object.entries(headEdits)) content[Number(k)] = v;
  const body = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x01, 0x2e, ...new Array(ADDR).fill(0x00), ...content];
  return [...body, 0x00, 0xf7];
}
function writeTap(name: string, frame: number[]): void {
  const tx = 'f0 00 01 74 11 01 2e 00 00 00 00 00 00 00 00 00 00 00 00 00 3b f7'; // the read request
  const text = `1700000000000 TX ${tx}\n1700000000001 RX ${frame.map((b) => b.toString(16).padStart(2, '0')).join(' ')}\n`;
  writeFileSync(`${HERE}/${name}`, text);
  console.log(`wrote ${name}  (frame ${frame.length}B)`);
}

writeTap('v2-head-self-base.tap', makeFrame({}, 0x00));
writeTap('v2-head-self-t1.tap', makeFrame({ 0: 0x02 }, 0x10));
writeTap('v2-head-self-t2.tap', makeFrame({}, 0x10));
writeTap('v2-head-self-t3.tap', makeFrame({ 0: 0x02 }, 0x10));
