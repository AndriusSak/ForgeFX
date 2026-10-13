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
//   1. PARSE. Every *.ts in the scanned dir parses (syntactic diagnostics = 0). A file that does not
//      parse is invisible to the run-only check. Under the committed `tsconfig.probe-check.json` (which
//      EXTENDS the server config and adds `scripts/**/*.ts` to its include) the whole program's
//      SYNTACTIC diagnostics are also asserted zero; its SEMANTIC diagnostic count is printed as an
//      ADVISORY only, because ~30 scripts/ files carry pre-existing strict-mode type debt that is out
//      of scope for this gate (a hard gate on it would be red on a clean checkout).
//   2. PRECEDENCE. No comparison is chained onto an un-parenthesised bitwise expression
//      (`a & b !== c`). Comments and strings are stripped first, so the probe that documents this
//      hazard in prose is not flagged.
//   3. DEVICE-FAILURE BRANCH. A probe that opens a session (`openProbeSession`) must PRINT a
//      device-failure branch and return exit 3 rather than throwing.
//   4. IMPORT GUARD. A file exporting `main` must not invoke it at import time — it must guard with
//      `import.meta.url === pathToFileURL(process.argv[1])` (the existing probes' convention).
//   5. MODE HEADER. A `probe-*.ts` header must state its read/write mode (read-only / dry-run / writes …).
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

/**
 * Replace the contents of line comments, block comments, and string/template literals with spaces,
 * preserving offsets and line breaks. Length-preserving so reported line numbers stay correct.
 * Not a full lexer, but exact for the classes this checker scans (a regex literal containing `//` or a
 * quote inside a regex could confuse it — no probe in scripts/ has one, and a parse error would surface
 * in check 1 anyway).
 */
function stripCommentsAndStrings(src: string): string {
  const out = src.split('');
  const n = src.length;
  const blank = (i: number): void => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        blank(i);
        i++;
      }
    } else if (c === '/' && d === '*') {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        blank(i);
        i++;
      }
      if (i < n) {
        blank(i);
        blank(i + 1);
        i += 2;
      }
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      blank(i);
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          blank(i);
          i++;
        }
        blank(i);
        i++;
      }
      if (i < n) {
        blank(i);
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

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
// `X & (Y !== Z)`. Requiring a bare operand token (word / dotted / indexed) between the bitwise
// operator and the comparison, and excluding `&&`/`||`/`&=`/`|=`, keeps the parenthesised form
// `(X & Y) !== Z` — where a `)` stands between the operand and the comparison — out of scope.
const PRECEDENCE_RE =
  /(?<![&|^])[&|^](?![&|=])[ \t]+[A-Za-z0-9_$\]]+(?:\.[A-Za-z0-9_$\]]+)*[ \t]*(===|!==|==|!=|<=|>=)/g;

function checkPrecedence(displayName: string, src: string): string[] {
  const stripped = stripCommentsAndStrings(src);
  const findings: string[] = [];
  const lines = stripped.split('\n');
  const rawLines = src.split('\n');
  lines.forEach((ln, idx) => {
    PRECEDENCE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PRECEDENCE_RE.exec(ln)) !== null) {
      findings.push(
        `${displayName}:${idx + 1}: comparison '${m[1]}' chained onto a bitwise expression — parenthesise: ` +
          `\`(a & b) ${m[1]} c\`, not \`a & b ${m[1]} c\`\n      ${(rawLines[idx] ?? '').trim()}`,
      );
    }
  });
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

const DETECTORS: Array<{ name: string; run: (f: string, s: string) => string[] }> = [
  { name: 'precedence', run: checkPrecedence },
  { name: 'device-failure', run: checkDeviceFailureBranch },
  { name: 'import-guard', run: checkImportGuard },
  { name: 'mode-header', run: checkModeHeader },
  { name: 'parse', run: checkParses },
];

// ── self-test: each detector must FIRE on a broken fixture and stay silent on a correct one ────────

const SELFTEST_FIXTURES: Array<{ name: string; file: string; bad: string; good: string }> = [
  {
    name: 'precedence',
    file: 'probe-planted.ts',
    bad: 'const tc = 0x52;\nconst x = (tc >> 4) & 0xf !== 5;\n',
    good: 'const tc = 0x52;\nconst x = ((tc >> 4) & 0xf) !== 5;\n',
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
    const det = DETECTORS.find((d) => d.name === fd.name)!;
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
    if (statSync(p).isFile() && name.endsWith('.ts')) out.push(p);
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
    const disp = explicitDir ? relative(process.cwd(), f) : join('scripts', basename(f));
    for (const d of DETECTORS) {
      const hits = d.run(disp, src);
      findings[d.name]!.push(...hits);
      if (hits.length) perFile.push(hits);
    }
  }

  // Program-level syntactic check under the committed tsconfig (default dir only — a scratch copy is
  // not a project tree). Semantic diagnostics are advisory: pre-existing type debt in scripts/.
  let programSyntactic = 0;
  let programSemantic = 0;
  let programNote = '';
  if (!explicitDir) {
    const cfg = resolve(HERE, '..', 'tsconfig.probe-check.json');
    try {
      const raw = ts.readConfigFile(cfg, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, resolve(HERE, '..'));
      const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
      programSyntactic = program.getSyntacticDiagnostics().length;
      programSemantic = program.getSemanticDiagnostics().length;
      programNote = `tsconfig.probe-check.json (${parsed.fileNames.length} files)`;
    } catch (e) {
      programNote = `tsconfig.probe-check.json UNREADABLE: ${e instanceof Error ? e.message : String(e)}`;
      programSyntactic = -1;
    }
  }

  const totalFindings = Object.values(findings).reduce((n, v) => n + v.length, 0);
  const failing = totalFindings > 0 || programSyntactic !== 0;

  console.log(`check-probes: dir=${dir} files=${files.length}${programNote ? ` · ${programNote}` : ''}`);
  for (const d of DETECTORS) {
    const hits = findings[d.name]!;
    console.log(`  ${hits.length === 0 ? 'ok  ' : 'FAIL'} ${d.name.padEnd(15)} ${hits.length} finding(s)`);
  }
  if (programNote && !explicitDir) {
    console.log(
      `  ${programSyntactic === 0 ? 'ok  ' : 'FAIL'} program-parse    syntactic=${programSyntactic} (advisory: semantic=${programSemantic} pre-existing strict-mode type debt in scripts/, not gated)`,
    );
  }
  if (totalFindings) {
    console.log('\nfindings:');
    for (const hs of perFile) for (const h of hs) console.log(`  ${h}`);
  }
  console.log(
    `\nsummary: ${totalFindings} finding(s); ${failing ? 'FAIL' : 'PASS'}`,
  );
  return failing ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
