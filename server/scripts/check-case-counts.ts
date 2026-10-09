/**
 * check-case-counts.ts — find hand-kept test-count constants and compare them to
 * the number of test cases actually written in the same file.
 *
 * WHY: every suite in this stack exports a constant like
 *   `export const PERFORM_PAGE_CASE_COUNT = 4;`
 * and nothing checks it against the file. It silently drifts. The DANGEROUS
 * direction is a constant that is LOWER than the cases present: it means cases
 * nobody thinks are running. This script exits non-zero for that direction and
 * prints the (often legitimate) higher-than-counted direction as an advisory.
 *
 * USAGE (run from ForgeFX/server):
 *   npx tsx scripts/check-case-counts.ts [--root <dir>]
 * `--root` is the STACK root that contains the sibling repos; it defaults to the
 * stack root inferred from this script's location (../../../). A temp tree with
 * the same layout can be passed for the positive control.
 *
 * WHAT IT COUNTS (the conventions this script TRUSTS as one case each):
 *   1. bare case blocks — a line whose only content is `{` (a block statement),
 *      at the outermost such indentation in the file, and NOT an object/array
 *      literal (the previous code line does not end in `[ , ( => :`). This is
 *      the dominant convention in ForgeFX/server drivers and several midi suites.
 *   2. vitest `it('…', …)` / `test('…', …)` calls (Axis uses vitest; it has no
 *      *_COUNT constants today, but the convention is supported).
 *   The effective count is the MAX of the two.
 *
 * WHAT IT REPORTS BUT DOES NOT ACT ON:
 *   - numbered `// N.` comment markers: reported as `numbered=N` for context.
 *     They are NOT a failure signal because numbering is scoped inconsistently
 *     across this stack — the same integer series is used for assertion groups
 *     inside a device loop (`cache/rigv2replay` numbers 1..3 over 2 devices),
 *     for per-runner case ids that continue into a SECOND runner with its own
 *     constant (`perform-page` numbers 1..4 then 5 for the patch suite), and in
 *     prose/docstring lists (`fm3/preset-author-ir`). Treating them as cases
 *     would over-claim, and an over-claiming checker is worse than none.
 *   - derived constants (`= cases.length`, `= A.length + 4`) are self-consistent
 *     by construction and are skipped.
 *
 * WHAT IT CANNOT SEE (stated plainly, not papered over):
 *   - Suites that express cases ONLY as numbered comments or as prose steps
 *     (most of forgefx-midi, several ForgeFX api/* suites) yield counted=0 under
 *     the conventions above and are therefore reported as advisories only. For
 *     those the tool cannot prove an absence OR a surplus — it stays silent.
 *   - `assert*` groups are not counted: many asserts execute per case, so assert
 *     count is not a case count.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { root: string } {
  let root = resolve(HERE, '..', '..', '..'); // scripts/ -> server -> ForgeFX -> stack
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = resolve(argv[++i] ?? root);
    else if (argv[i].startsWith('--root=')) root = resolve(argv[i].slice('--root='.length));
  }
  return { root };
}

const { root } = parseArgs(process.argv.slice(2));

// The three test trees, relative to the stack root.
const TREES = [
  'ForgeFX/server/test',
  'forgefx-midi/test',
  'Axis/src',
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Line/block comment or blank — skipped when looking for the previous code line. */
function isCommentOrBlank(s: string): boolean {
  const t = s.trim();
  return t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Count bare case blocks: lone `{` lines that are block statements, restricted
 * to the outermost indentation level at which they occur. An object/array
 * literal opener is recognised by the previous code line ending in `[` `,` `(`
 * `=>` or `:`.
 */
function countBareBlocks(src: string): number {
  const lines = src.split('\n');
  const prevCode = (i: number): string => {
    let j = i - 1;
    while (j >= 0) {
      if (!isCommentOrBlank(lines[j]!)) return lines[j]!.trim();
      j--;
    }
    return '';
  };
  const stmtIndents: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (!/^\s*\{\s*$/.test(ln)) continue;
    const p = prevCode(i);
    const isLiteral =
      p.endsWith('[') || p.endsWith(',') || p.endsWith('(') || p.endsWith('=>') || p.endsWith(':');
    if (isLiteral) continue;
    stmtIndents.push(ln.length - ln.trimStart().length);
  }
  if (stmtIndents.length === 0) return 0;
  const min = Math.min(...stmtIndents);
  return stmtIndents.filter((n) => n === min).length;
}

function countItCalls(src: string): number {
  return (src.match(/\b(it|test)\s*\(\s*['"`]/g) ?? []).length;
}

/** Distinct numbered `// N.` comment markers — DIAGNOSTIC ONLY (see header). */
function countNumberedMarks(src: string): number {
  const nums = new Set<number>();
  for (const ln of src.split('\n')) {
    const m = /^\s*\/\/\s*(\d+)[.)]\s/.exec(ln);
    if (m) nums.add(Number(m[1]));
  }
  return nums.size;
}

interface Declared {
  name: string;
  expr: string;
  value: number | null; // null => derived (not a numeric literal)
}

function declaredCounts(src: string): Declared[] {
  const out: Declared[] = [];
  const re = /export\s+const\s+([A-Z][A-Z0-9_]*_COUNT)\s*=\s*([^;\n]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const expr = m[2]!.trim();
    out.push({ name: m[1]!, expr, value: /^\d+$/.test(expr) ? Number(expr) : null });
  }
  return out;
}

interface Row {
  file: string;
  name: string;
  declared: number | null;
  expr: string;
  counted: number;
  blocks: number;
  it: number;
  numbered: number;
  delta: number | null;
  derived: boolean;
}

const files = TREES.flatMap((t) => walk(join(root, t)));
const rows: Row[] = [];

for (const f of files) {
  let src: string;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const decls = declaredCounts(src);
  if (decls.length === 0) continue;
  const blocks = countBareBlocks(src);
  const it = countItCalls(src);
  const counted = Math.max(blocks, it);
  const numbered = countNumberedMarks(src);
  for (const d of decls) {
    rows.push({
      file: relative(root, f),
      name: d.name,
      declared: d.value,
      expr: d.expr,
      counted,
      blocks,
      it,
      numbered,
      delta: d.value === null ? null : counted - d.value,
      derived: d.value === null,
    });
  }
}

// --- report ---------------------------------------------------------------
const failures: Row[] = [];
const advisories: Row[] = [];
const matches: Row[] = [];
const derived: Row[] = [];

for (const r of rows) {
  if (r.derived) derived.push(r);
  else if ((r.declared as number) < r.counted) failures.push(r);
  else if ((r.declared as number) > r.counted) advisories.push(r);
  else matches.push(r);
}

const fmt = (r: Row): string => {
  const dec = r.derived ? r.expr : String(r.declared);
  const d = r.delta === null ? '' : r.delta > 0 ? `+${r.delta}` : String(r.delta);
  return `${r.name} declared=${dec} counted=${r.counted} delta=${d || '0'} (blocks=${r.blocks} it=${r.it} numbered=${r.numbered}) ${r.file}`;
};

console.log(`check-case-counts: root=${root}`);
console.log(`scanned ${files.length} *.test.ts files; ${rows.length} *_COUNT constants (${derived.length} derived)`);

if (failures.length) {
  console.log('\nFAIL — declared FEWER than counted (cases exist that are not claimed):');
  for (const r of failures) console.log(`  FAIL  ${fmt(r)}`);
}
if (matches.length) {
  console.log('\nOK — declared == counted:');
  for (const r of matches) console.log(`  ok    ${fmt(r)}`);
}
if (advisories.length) {
  console.log('\nADVISORY — declared HIGHER than counted (often legitimate: numbered/array/prose conventions):');
  for (const r of advisories) console.log(`  adv   ${fmt(r)}`);
}
if (derived.length) {
  console.log('\nDERIVED — count is computed at module load (cannot drift):');
  for (const r of derived) console.log(`  derived ${r.name} = ${r.expr}  ${r.file}`);
}

console.log(
  `\nsummary: ${failures.length} failing, ${matches.length} ok, ${advisories.length} advisory, ${derived.length} derived`,
);
process.exit(failures.length > 0 ? 1 : 0);
