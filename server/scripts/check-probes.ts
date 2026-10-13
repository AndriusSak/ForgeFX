// ────────────────────────────────────────────────────────────────────────────────────────────────
// check-probes — load and cheaply exercise the probe/tooling directory, which NOTHING else checks.
//
// WHY THIS EXISTS: `ForgeFX/server/tsconfig.json` sets `include: ['src/**/*.ts']`, so `npm run
// typecheck` never sees `scripts/**`. A probe is only ever checked by RUNNING it, which needs a device
// — which is why a precedence bug in a brand-new probe survived every green suite.
//
// MEASURED 2026-10-13 (the cost this step pays for): `(tc >> 4) & 0xf !== 5` is parsed by JS as
// `(tc >> 4) & (0xf !== 5)`, i.e. `number & true` = `number & 1` — so the predicate was TRUE for both
// even and odd nibbles. The probe swept 505 rows of a 17-row class and was caught only because a human
// read the printed count. The precedence check below fires on that exact shape and NOT on the
// parenthesised form.
//
// WHAT IT CHECKS (all offline, no device, no serial port — safe to run while the server holds the unit):
//   1. PARSE. Every *.ts in the scanned dir (RECURSIVELY — subdirectories are walked) parses (syntactic
//      diagnostics = 0). A file that does not parse is invisible to the run-only check. Under the
//      committed `tsconfig.probe-check.json` (which EXTENDS the server config and adds `scripts/**/*.ts`
//      to its include) the whole program's SYNTACTIC diagnostics are also asserted zero; its SEMANTIC
//      diagnostic count is printed as an ADVISORY only, because ~30 scripts/ files carry pre-existing
//      strict-mode type debt that is out of scope for this gate (a hard gate on it would be red on a
//      clean checkout).
//   2. PRECEDENCE. No comparison is chained onto an un-parenthesised bitwise expression (`a & b !== c`).
//      AST-based (a `&`/`|`/`^` BinaryExpression whose RIGHT operand is a comparison), so it catches
//      every sibling of the shape — bare `<`/`>`, any whitespace, indexed and call operands — and, unlike
//      a regex, never mistakes a TYPE union for a value comparison. Check 6 is still the deeper catch:
//      the AST sees the SHAPE, the type-checker sees the OPERAND TYPES.
//   3. DEVICE-FAILURE BRANCH. A probe that opens a session (`openProbeSession`) must PRINT a
//      device-failure branch and return exit 3 rather than throwing.
//   4. IMPORT GUARD. A file exporting `main` must not invoke it at import time — it must guard with
//      `import.meta.url === pathToFileURL(process.argv[1])` (the existing probes' convention).
//   5. MODE HEADER. A `probe-*.ts` header must state its read/write mode (read-only / dry-run / writes …).
//   6. SEMANTIC TYPE GATE (the strong one). The TypeScript program built below is asked for its SEMANTIC
//      diagnostics and the codes that a precedence slip produces are a HARD failure:
//        TS2362 / TS2363 — an arithmetic operand is not a number (e.g. `number & boolean`, exactly what
//                          `(tc >> 4) & 0xf !== 5` becomes once the comparison is absorbed);
//        TS2367         — a comparison of two types with no overlap (a literal compared to a value it can
//                          never equal, e.g. a bitwise result vs an unrelated string literal).
//      EVERY OTHER semantic code stays ADVISORY (the pre-existing strict-mode debt), printed as a count
//      as before. This beats any regex: it is a type-level statement about the operands, not a shape.
//
// USAGE (run from ForgeFX/server):
//   npx tsx scripts/check-probes.ts             # scan scripts/
//   npx tsx scripts/check-probes.ts --dir <path> # scan a scratch COPY (the planted-fixture control)
//   npx tsx scripts/check-probes.ts --selftest   # run the detectors' own planted fixtures
//
// POSITIVE CONTROL: `--selftest` feeds each detector a deliberately broken fixture and asserts it
// FIRES, and a correct fixture and asserts it does NOT. A checker that cannot fail is worse than none.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { dir: string; selftest: boolean; explicitDir: boolean } {
  let dir = HERE;
  let explicitDir = false;
  let selftest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dir') {
      dir = resolve(argv[++i] ?? dir);
      explicitDir = true;
    } else if (a.startsWith('--dir=')) {
      dir = resolve(a.slice('--dir='.length));
      explicitDir = true;
    } else if (a === '--selftest') {
      selftest = true;
    }
  }
  return { dir, selftest, explicitDir };
}

// ── source text utilities ───────────────────────────────────────────────────────────────────────

/** Leading run of blank/comment lines — a file's header block. */
function headerBlock(src: string): string {
  const out: string[] = [];
  for (const line of src.split('\n')) {
    const s = line.trim();
    if (s === '' || s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')) out.push(line);
    else break;
  }
  return out.join('\n');
}

// ── detectors (each returns a list of human-readable findings) ────────────────────────────────────

// A comparison chained onto an un-parenthesised bitwise expression: `X & Y !== Z` parses as
// `X & (Y !== Z)`, because every comparison/relational operator binds TIGHTER than `&`/`|`/`^`. The
// detector is therefore AST-based, not lexical: it walks the parse tree for a BinaryExpression whose
// operator is `&`/`|`/`^` AND whose RIGHT operand is itself a comparison BinaryExpression — the exact,
// unambiguous structure of the bug. That single rule closes every sibling of the shape at once:
//   • bare `<` / `>` as well as `<=`/`>=`/`==`/`!=`/`===`/`!==` (`a & b < c` → `a & (b < c)`);
//   • whitespace is irrelevant (`x&0xf!==5` is the same tree as `x & 0xf !== 5`);
//   • indexed (`a & b[i] !== c`) and call (`a & f(x) !== c`) operands fall out for free;
//   • `<<`/`>>` and `&&`/`||` are NOT comparisons/bitwise, so they never match.
// A LEXICAL pattern cannot do this job: `Promise<ObservedBody | null>` and `A | Record<string, number>`
// are TYPE unions that every regex spelling reads as `| null >` / `| Record <`, and an expanded regex
// flagged 18 such type annotations across the real scripts/ tree (measured) — false positives that made
// the gate red on a clean checkout. A type is not a BinaryExpression, so the AST has no such ambiguity.
// The parenthesised form `(X & Y) !== Z` is naturally out of scope: there the `&` node is the
// comparison's LEFT operand, not its right.
const BITWISE_OP_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
]);
const COMPARISON_OP_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function checkPrecedence(displayName: string, src: string): string[] {
  const sf = ts.createSourceFile(displayName, src, ts.ScriptTarget.ES2022, true);
  const lines = sf.text.split('\n');
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && BITWISE_OP_KINDS.has(node.operatorToken.kind)) {
      const rhs = node.right;
      if (ts.isBinaryExpression(rhs) && COMPARISON_OP_KINDS.has(rhs.operatorToken.kind)) {
        const bit = node.operatorToken.getText(sf);
        const cmp = rhs.operatorToken.getText(sf);
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        findings.push(
          `${displayName}:${line + 1}: comparison '${cmp}' chained onto a bitwise expression — parenthesise: ` +
            `\`(a ${bit} b) ${cmp} c\`, not \`a ${bit} b ${cmp} c\`\n      ${(lines[line] ?? '').trim()}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function checkDeviceFailureBranch(displayName: string, src: string): string[] {
  const findings: string[] = [];
  // probe-device.ts DEFINES the convention (openProbeSession + the shared `main`); it is the library the
  // other probes import, not a probe that must itself return 3.
  if (basename(displayName) === 'probe-device.ts') return findings;
  const opens = /\bopenProbeSession\s*\(/.test(src);
  if (!opens) return findings;
  const hasOkBranch = /\bif\s*\(\s*!\s*\w+\.ok\s*\)/.test(src) || /\bif\s*\(\s*\w+\.ok\s*\)/.test(src);
  const returns3 = /\breturn\s+3\b/.test(src) || /process\.exit\(\s*3\s*\)/.test(src);
  if (!hasOkBranch)
    findings.push(
      `${displayName}: opens a session but has no device-failure branch (\`if (!opened.ok)\`) — a missing ` +
        `device must PRINT a failure and exit 3, never throw`,
    );
  else if (!returns3)
    findings.push(
      `${displayName}: opens a session but the failure branch does not return/exit 3 (the device-absent convention)`,
    );
  return findings;
}

function checkImportGuard(displayName: string, src: string): string[] {
  const findings: string[] = [];
  const exportsMain = /export\s+(?:async\s+)?function\s+main\b|export\s+const\s+main\b/.test(src);
  if (!exportsMain) return findings;
  const guarded =
    /import\.meta\.url/.test(src) && /pathToFileURL\(\s*process\.argv\[1\]\s*\)/.test(src);
  if (!guarded)
    findings.push(
      `${displayName}: exports \`main\` but has no \`import.meta.url === pathToFileURL(process.argv[1])\` ` +
        `guard — it must not run at import time`,
    );
  return findings;
}

const MODE_RE =
  /read-only|read\/write|read-write|read-class|read \((?:mostly|only)\)|destructive|dry-run|dry run|plan only|writes nothing|nothing is written|no write|\bwrite\b|\bwrites\b/i;

function checkModeHeader(displayName: string, src: string): string[] {
  if (!basename(displayName).startsWith('probe-')) return [];
  const header = headerBlock(src);
  if (MODE_RE.test(header)) return [];
  return [`${displayName}: header does not state its read/write mode (READ-ONLY / dry-run / writes …)`];
}

function checkParses(displayName: string, src: string): string[] {
  const sf = ts.createSourceFile(displayName, src, ts.ScriptTarget.ES2022, true);
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.map((d) => {
    const pos = d.start != null ? sf.getLineAndCharacterOfPosition(d.start) : null;
    const where = pos ? `:${pos.line + 1}:${pos.character + 1}` : '';
    return `${displayName}${where}: parse error: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
}

// ── semantic type gate (the strong detector; these three codes are HARD, every other code advisory) ──

/** Codes a bitwise/comparison precedence slip produces. TS2362/TS2363: an arithmetic operand is not a
 *  number (`number & boolean`, exactly what `(tc >> 4) & 0xf !== 5` becomes). TS2367: a comparison of
 *  two types with no overlap. */
const SEMANTIC_HARD_CODES = new Set([2362, 2363, 2367]);

/**
 * Type-check ONE file in isolation and return its diagnostics whose code is in {@link SEMANTIC_HARD_CODES}.
 * Used by `--selftest` (a single-string fixture is not a project tree) and to corroborate the source-text
 * detectors per file. `noLib`/`noResolve` keep it hermetic and cheap; the gated codes are intrinsic-type
 * facts that need no libraries (`number & boolean`, a disjoint-literal comparison).
 */
function checkSemanticTypes(displayName: string, src: string): string[] {
  const fileName = displayName.endsWith('.ts') ? displayName : `${displayName}.ts`;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fn) => (fn === fileName ? ts.createSourceFile(fn, src, ts.ScriptTarget.ES2022, true) : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fn) => fn === fileName,
    readFile: (fn) => (fn === fileName ? src : undefined),
  };
  const program = ts.createProgram([fileName], options, host);
  const sf = program.getSourceFile(fileName);
  if (!sf) return [];
  const out: string[] = [];
  for (const d of program.getSemanticDiagnostics(sf)) {
    if (!SEMANTIC_HARD_CODES.has(d.code)) continue;
    const pos = d.start != null ? sf.getLineAndCharacterOfPosition(d.start) : null;
    const where = pos ? `:${pos.line + 1}:${pos.character + 1}` : '';
    out.push(`${displayName}${where}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  return out;
}

type Detector = { name: string; run: (f: string, s: string) => string[] };

const DETECTORS: Detector[] = [
  { name: 'precedence', run: checkPrecedence },
  { name: 'device-failure', run: checkDeviceFailureBranch },
  { name: 'import-guard', run: checkImportGuard },
  { name: 'mode-header', run: checkModeHeader },
  { name: 'parse', run: checkParses },
];

// The semantic detector is NOT in the per-file scan list — the PROGRAM-level gate below type-checks the
// whole tree against `tsconfig.probe-check.json` (accurate, one program) rather than re-creating a
// throwaway program per file. It IS exercised by --selftest, so its broken/correct fixtures still run.
const DETECTOR_BY_NAME = new Map<string, Detector>(
  [...DETECTORS, { name: 'semantic-type', run: checkSemanticTypes }].map((d) => [d.name, d]),
);

// ── self-test: each detector must FIRE on a broken fixture and stay silent on a correct one ────────

const SELFTEST_FIXTURES: Array<{ name: string; file: string; bad: string; good: string }> = [
  {
    name: 'precedence',
    file: 'probe-planted.ts',
    bad: 'const tc = 0x52;\nconst x = (tc >> 4) & 0xf !== 5;\n',
    good: 'const tc = 0x52;\nconst x = ((tc >> 4) & 0xf) !== 5;\n',
  },
  // bare `<` / `>` (previously only `<=`/`>=` fired) — same bug; `<<`/`>>` must STAY silent.
  {
    name: 'precedence',
    file: 'probe-planted.ts',
    bad: 'const a = 1, b = 2, c = 3;\nconst x = a & b < c;\n',
    good: 'const a = 1, b = 2, c = 3;\nconst x = (a & b) < c;\nconst y = a & b << c;\nconst z = a & b >> c;\n',
  },
  // no space after the bitwise operator (`[ \t]+` used to be required).
  {
    name: 'precedence',
    file: 'probe-planted.ts',
    bad: 'const x = a&b!==c;\n',
    good: 'const x = (a&b)!==c;\nconst y = a&&b;\n',
  },
  // indexed right operand (the operand pattern now allows `[…]` suffixes).
  {
    name: 'precedence',
    file: 'probe-planted.ts',
    bad: 'const x = a & b[i] !== c;\n',
    good: 'const x = (a & b[i]) !== c;\n',
  },
  // call right operand (the operand pattern now allows `(…)` suffixes).
  {
    name: 'precedence',
    file: 'probe-planted.ts',
    bad: 'const x = a & f(x) !== c;\n',
    good: 'const x = (a & f(x)) !== c;\n',
  },
  // The SEMANTIC gate: TS2362/TS2363 on the real precedence shape, and TS2367 on a disjoint comparison.
  {
    name: 'semantic-type',
    file: 'probe-planted.ts',
    bad: 'const tc = 0x52;\nconst x = (tc >> 4) & 0xf !== 5;\n',
    good: 'const tc = 0x52;\nconst x = ((tc >> 4) & 0xf) !== 5;\n',
  },
  {
    name: 'semantic-type',
    file: 'probe-planted.ts',
    bad: "const v: 'A' | 'B' = 'A';\nconst y = v === 'C';\n",
    good: "const v: 'A' | 'B' = 'A';\nconst y = v === 'A';\n",
  },
  {
    name: 'device-failure',
    file: 'probe-planted.ts',
    bad: "import { openProbeSession } from './probe-device.js';\nconst s = await openProbeSession(0x11);\n",
    good:
      "import { openProbeSession } from './probe-device.js';\nconst s = await openProbeSession(0x11);\nif (!s.ok) { console.log('no device'); return 3; }\n",
  },
  {
    name: 'import-guard',
    file: 'probe-planted.ts',
    bad: 'export async function main() { return 0; }\nmain().then((c) => process.exit(c));\n',
    good:
      "import { pathToFileURL } from 'node:url';\nexport async function main() { return 0; }\nif (import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => process.exit(c));\n",
  },
  {
    name: 'mode-header',
    file: 'probe-planted.ts',
    bad: '// probe-planted — what does it even do?\nexport async function main() { return 0; }\n',
    good: '// probe-planted — READ-ONLY.\nexport async function main() { return 0; }\n',
  },
  {
    name: 'parse',
    file: 'probe-planted.ts',
    bad: 'const x = (1 + 2;\n',
    good: 'const x = (1 + 2);\n',
  },
];

function runSelftest(): number {
  let failed = 0;
  for (const fd of SELFTEST_FIXTURES) {
    const det = DETECTOR_BY_NAME.get(fd.name);
    if (!det) {
      console.log(`FAIL detector '${fd.name}': no such detector`);
      failed++;
      continue;
    }
    const badHits = det.run(fd.file, fd.bad);
    const goodHits = det.run(fd.file, fd.good);
    const ok = badHits.length > 0 && goodHits.length === 0;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} detector '${fd.name}': broken fixture fired=${badHits.length} ` +
        `(want >0), correct fixture fired=${goodHits.length} (want 0)`,
    );
    if (!ok) {
      failed++;
      for (const h of badHits) console.log(`       bad→ ${h}`);
      for (const h of goodHits) console.log(`       good→ ${h}`);
    }
  }
  console.log(
    `\ncheck-probes --selftest: ${SELFTEST_FIXTURES.length - failed}/${SELFTEST_FIXTURES.length} detectors discriminate broken from correct.`,
  );
  return failed > 0 ? 1 : 0;
}

// ── main scan ─────────────────────────────────────────────────────────────────────────────────────

/** Every *.ts under `dir`, RECURSIVELY (subdirectories included), sorted. A non-directory or an
 *  unreadable path yields nothing rather than throwing. */
function listTs(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const p = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listTs(p));
    else if (st.isFile() && name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

function main(argv: string[]): number {
  const { dir, selftest, explicitDir } = parseArgs(argv);
  if (selftest) return runSelftest();

  const files = listTs(dir);
  const findings: Record<string, string[]> = {};
  for (const d of DETECTORS) findings[d.name] = [];
  const perFile: string[][] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const disp = explicitDir ? relative(process.cwd(), f) : join('scripts', relative(dir, f));
    for (const d of DETECTORS) {
      const hits = d.run(disp, src);
      findings[d.name]!.push(...hits);
      if (hits.length) perFile.push(hits);
    }
  }

  // Program-level syntactic check under the committed tsconfig (default dir only — a scratch copy is
  // not a project tree). Syntactic = hard. SEMANTIC = the precedence codes (2362/2363/2367) HARD, the
  // rest advisory (pre-existing strict-mode type debt in scripts/).
  let programSyntactic = 0;
  let programSemantic = 0;
  let programSemanticHard: string[] = [];
  let programNote = '';
  if (!explicitDir) {
    const cfg = resolve(HERE, '..', 'tsconfig.probe-check.json');
    try {
      const raw = ts.readConfigFile(cfg, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, resolve(HERE, '..'));
      const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
      programSyntactic = program.getSyntacticDiagnostics().length;
      const sem = program.getSemanticDiagnostics();
      programSemantic = sem.length;
      // HARD: the precedence-slip codes. Everything else stays advisory (pre-existing strict-mode debt).
      programSemanticHard = sem
        .filter((d) => SEMANTIC_HARD_CODES.has(d.code))
        .map((d) => {
          const file = d.file?.fileName ?? '<unknown>';
          const pos = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : null;
          const where = pos ? `:${pos.line + 1}:${pos.character + 1}` : '';
          return `${relative(process.cwd(), file)}${where}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
        });
      programNote = `tsconfig.probe-check.json (${parsed.fileNames.length} files)`;
    } catch (e) {
      programNote = `tsconfig.probe-check.json UNREADABLE: ${e instanceof Error ? e.message : String(e)}`;
      programSyntactic = -1;
    }
  }

  const totalFindings = Object.values(findings).reduce((n, v) => n + v.length, 0);
  const failing = totalFindings > 0 || programSyntactic !== 0 || programSemanticHard.length > 0;

  console.log(`check-probes: dir=${dir} files=${files.length}${programNote ? ` · ${programNote}` : ''}`);
  for (const d of DETECTORS) {
    const hits = findings[d.name]!;
    console.log(`  ${hits.length === 0 ? 'ok  ' : 'FAIL'} ${d.name.padEnd(15)} ${hits.length} finding(s)`);
  }
  const hardCodeList = [...SEMANTIC_HARD_CODES].map((c) => `TS${c}`).join('/');
  if (programNote && !explicitDir) {
    console.log(`  ${programSyntactic === 0 ? 'ok  ' : 'FAIL'} program-parse    syntactic=${programSyntactic}`);
    console.log(
      `  ${programSemanticHard.length === 0 ? 'ok  ' : 'FAIL'} program-semantic HARD(${hardCodeList})=${programSemanticHard.length}` +
        ` · advisory=${programSemantic - programSemanticHard.length} (other pre-existing strict-mode type debt in src/scripts, not gated)`,
    );
  }
  if (totalFindings) {
    console.log('\nfindings:');
    for (const hs of perFile) for (const h of hs) console.log(`  ${h}`);
  }
  if (programSemanticHard.length) {
    console.log(`\nsemantic HARD findings (${hardCodeList} — precedence-slip shape):`);
    for (const hpt of programSemanticHard) console.log(`  ${hpt}`);
  }
  console.log(
    `\nsummary: ${totalFindings} finding(s), ${programSemanticHard.length} semantic-hard; ${failing ? 'FAIL' : 'PASS'}`,
  );
  return failing ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
