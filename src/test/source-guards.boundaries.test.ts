import { posix } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  collectNodes,
  describeLocation,
  isProductionFile,
  parseSource,
  readRepositoryFile,
  scanSourceTree,
} from "./source-scan.js";

interface ModuleReference {
  specifier: string;
  position: number;
}

interface BoundaryRule {
  id: string;
  rule: string;
  appliesTo: (file: string) => boolean;
  violates: (file: string, source: ts.SourceFile) => number[];
  spellings: { file: string; code: string; violates: boolean }[];
}

const minimumSourceFiles = 250;
const minimumProductionFiles = 120;
const packageName = "@geminixiang/mikan";
const moduleLoaderCalls = new Set([
  "vi.mock",
  "vi.doMock",
  "vi.unmock",
  "vi.doUnmock",
  "vi.importActual",
  "vi.importMock",
]);
const entryPointImportAllowlist = new Set(["src/index.ts", "src/test/public-api.test.ts"]);
const adapterImportAllowlist = ["src/main.ts", "src/index.ts", "src/cli/", "src/runtime/"];

const sources = scanSourceTree();
const productionFiles = sources.filter((source) => isProductionFile(source.file));
const productionDoubleAssertionBudget: Record<string, number> = {
  "src/adapters/slack/bot.ts": 1,
  "src/adapters/web/admin/portal.ts": 2,
  "src/adapters/web/session-view/portal.ts": 1,
  "src/sessions/migrate-pi-084.ts": 2,
  "src/sessions/migrate-v3.ts": 4,
  "src/sessions/session-store.ts": 1,
};

function publishedEntryPoints(): Map<string, string> {
  const manifest = JSON.parse(readRepositoryFile("package.json")) as {
    exports: Record<string, string | { import?: string }>;
  };
  const entries = new Map<string, string>();
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const importPath = typeof target === "string" ? target : target.import;
    if (!importPath?.startsWith("./dist/") || !importPath.endsWith(".js")) continue;
    const file = `src/${importPath.slice("./dist/".length, -".js".length)}.ts`;
    entries.set(posix.join(packageName, subpath), file);
  }
  return entries;
}

const entryPointsBySpecifier = publishedEntryPoints();
const entryPointFiles = new Set(entryPointsBySpecifier.values());
const knownFiles = new Set(sources.map((source) => source.file));

function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  const published = entryPointsBySpecifier.get(specifier);
  if (published) return published;
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.join(posix.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    posix.join(base, "index.ts"),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? candidates[0];
}

function moduleReferences(source: ts.SourceFile): ModuleReference[] {
  return collectNodes(source, (node) => {
    if (!ts.isStringLiteralLike(node)) return false;
    const parent = node.parent;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
      return parent.moduleSpecifier === node;
    }
    if (ts.isExternalModuleReference(parent)) return true;
    if (ts.isLiteralTypeNode(parent)) return ts.isImportTypeNode(parent.parent);
    if (!ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
    return (
      parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
      moduleLoaderCalls.has(parent.expression.getText())
    );
  }).map((node) => ({
    specifier: (node as ts.StringLiteralLike).text,
    position: node.getStart(),
  }));
}

function referencesResolvingTo(
  file: string,
  source: ts.SourceFile,
  target: (resolved: string) => boolean,
): number[] {
  return moduleReferences(source)
    .filter(({ specifier }) => {
      const resolved = resolveSpecifier(file, specifier);
      return resolved !== undefined && target(resolved);
    })
    .map(({ position }) => position);
}

function reExportPositions(source: ts.SourceFile): number[] {
  return source.statements
    .filter((statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier)
    .map((statement) => statement.getStart());
}

function doubleAssertionPositions(source: ts.SourceFile): number[] {
  const positions: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      let inner = node.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (
        (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) &&
        inner.type.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        positions.push(node.getStart(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return positions;
}

const rules: BoundaryRule[] = [
  {
    id: "re-export-only-in-entry-points",
    rule: `Only the published entry points (${[...entryPointFiles].join(", ")}, from package.json "exports") may contain export … from; import the value where it is used and export it from its owner instead`,
    appliesTo: (file) => !entryPointFiles.has(file),
    violates: (_file, source) => reExportPositions(source),
    spellings: [
      { file: "src/office/index.ts", code: 'export { a } from "./a.js";', violates: true },
      { file: "src/office/index.ts", code: 'export type { A } from "./types.js";', violates: true },
      { file: "src/office/index.ts", code: 'export * from "./a.js";', violates: true },
      { file: "src/office/index.ts", code: 'export * as a from "./a.js";', violates: true },
      {
        file: "src/test/x.test.ts",
        code: 'export {\n  a,\n  b,\n} from "../office/index.js";',
        violates: true,
      },
      {
        file: "src/office/index.ts",
        code: 'import { a } from "./a.js";\nexport { a };',
        violates: false,
      },
      { file: "src/office/index.ts", code: "export const a = 1;", violates: false },
      {
        file: "src/office/index.ts",
        code: 'export type { A };\nimport type { A } from "./types.js";',
        violates: false,
      },
    ],
  },
  {
    id: "no-import-through-entry-points",
    rule: `Code under src/ must not import through the published entry points (${[...entryPointFiles].join(", ")}); import from the owning module. Allowed: ${[...entryPointImportAllowlist].join(", ")}`,
    appliesTo: (file) => !entryPointImportAllowlist.has(file),
    violates: (file, source) =>
      referencesResolvingTo(file, source, (resolved) => entryPointFiles.has(resolved)),
    spellings: [
      {
        file: "src/runtime/x.ts",
        code: 'import { a } from "../harness/index.js";',
        violates: true,
      },
      {
        file: "src/runtime/x.ts",
        code: 'import type { A } from "../sandbox/index.js";',
        violates: true,
      },
      { file: "src/harness/x.ts", code: 'import { a } from "./index.js";', violates: true },
      { file: "src/harness/tools/x.ts", code: "import { a } from '..';", violates: true },
      { file: "src/test/x.test.ts", code: 'import { a } from "../index.js";', violates: true },
      {
        file: "src/test/x.test.ts",
        code: 'import { a } from "@geminixiang/mikan";',
        violates: true,
      },
      {
        file: "src/test/x.test.ts",
        code: 'const m = await import("@geminixiang/mikan/harness");',
        violates: true,
      },
      {
        file: "src/test/x.test.ts",
        code: 'vi.mock("../sandbox/index.js", () => ({}));',
        violates: true,
      },
      {
        file: "src/test/x.test.ts",
        code: 'type T = import("../harness/index.js").T;',
        violates: true,
      },
      {
        file: "src/runtime/x.ts",
        code: 'export { a } from "../harness/index.js";',
        violates: true,
      },
      {
        file: "src/runtime/x.ts",
        code: 'import { a } from "../harness/runner.js";',
        violates: false,
      },
      {
        file: "src/runtime/x.ts",
        code: 'import { a } from "../office/index.js";',
        violates: false,
      },
      {
        file: "src/runtime/x.ts",
        code: 'import { a } from "../sandbox/layout.js";',
        violates: false,
      },
      { file: "src/test/x.test.ts", code: 'vi.mock("../harness/runner.js");', violates: false },
      { file: "src/test/x.test.ts", code: 'const text = "../harness/index.js";', violates: false },
    ],
  },
  {
    id: "no-adapter-imports-outside-composition",
    rule: `Production modules outside src/adapters/ must not import from src/adapters/; pass the value in from the composition root. Allowed: ${adapterImportAllowlist.join(", ")}`,
    appliesTo: (file) =>
      isProductionFile(file) &&
      !file.startsWith("src/adapters/") &&
      !adapterImportAllowlist.some((allowed) =>
        allowed.endsWith("/") ? file.startsWith(allowed) : file === allowed,
      ),
    violates: (file, source) =>
      referencesResolvingTo(file, source, (resolved) => resolved.startsWith("src/adapters/")),
    spellings: [
      {
        file: "src/harness/x.ts",
        code: 'import { a } from "../adapters/slack/bot.js";',
        violates: true,
      },
      {
        file: "src/harness/tools/x.ts",
        code: 'import type { A } from "../../adapters/types.js";',
        violates: true,
      },
      {
        file: "src/office/x.ts",
        code: 'const m = await import("../adapters/index.js");',
        violates: true,
      },
      { file: "src/x.ts", code: 'import { a } from "./adapters/shared.js";', violates: true },
      {
        file: "src/harness/x.ts",
        code: 'import { a } from "../office/index.js";',
        violates: false,
      },
      {
        file: "src/harness/x.ts",
        code: 'const text = "../adapters/slack/bot.js";',
        violates: false,
      },
      { file: "src/harness/x.ts", code: 'import { a } from "./adapters.js";', violates: false },
    ],
  },
  {
    id: "no-double-assertion-in-tests",
    rule: "Tests must not bypass the type checker with a double assertion through unknown; build typed fakes, narrow the production parameter type, or inject the dependency through the class options",
    appliesTo: (file) => file.startsWith("src/test/"),
    violates: (_file, source) => doubleAssertionPositions(source),
    spellings: [
      { file: "src/test/x.test.ts", code: "const a = b as unknown as A;", violates: true },
      { file: "src/test/x.test.ts", code: "const a = (b as unknown) as A;", violates: true },
      { file: "src/test/x.test.ts", code: "const a = <A>(<unknown>b);", violates: true },
      {
        file: "src/test/x.test.ts",
        code: "const a = (\n  b as unknown\n) as A;",
        violates: true,
      },
      { file: "src/test/x.test.ts", code: "const a = b as A;", violates: false },
      { file: "src/test/x.test.ts", code: "const a = b as unknown;", violates: false },
      { file: "src/test/x.test.ts", code: 'const a = "as unknown as A";', violates: false },
      { file: "src/runtime/x.ts", code: "const a = b as unknown as A;", violates: false },
    ],
  },
];

function spellingViolates(rule: BoundaryRule, file: string, code: string): boolean {
  return rule.appliesTo(file) && rule.violates(file, parseSource(file, code)).length > 0;
}

describe("boundary guard patterns", () => {
  test("package.json exports resolve to the published entry points", () => {
    expect([...entryPointFiles]).toEqual(
      expect.arrayContaining(["src/harness/index.ts", "src/index.ts", "src/sandbox/index.ts"]),
    );
    expect([...entryPointFiles].filter((file) => !knownFiles.has(file))).toEqual([]);
  });

  test("every allowlisted file still exists", () => {
    const missing = [
      ...entryPointImportAllowlist,
      ...adapterImportAllowlist.filter((allowed) => !allowed.endsWith("/")),
    ].filter((file) => !knownFiles.has(file));
    expect(missing).toEqual([]);
  });

  test("each rule flags every violating spelling and no conforming one", () => {
    const wrong = rules.flatMap((rule) =>
      rule.spellings
        .filter(({ file, code, violates }) => spellingViolates(rule, file, code) !== violates)
        .map(
          ({ file, code, violates }) =>
            `${rule.id} ${violates ? "misses" : "wrongly flags"} (${file}):\n${code}`,
        ),
    );
    expect(wrong.join("\n\n")).toBe("");
  });

  test("each rule has violating and conforming spellings", () => {
    const thin = rules.filter(
      (rule) =>
        !rule.spellings.some((spelling) => spelling.violates) ||
        !rule.spellings.some((spelling) => !spelling.violates),
    );
    expect(thin.map((rule) => rule.id)).toEqual([]);
  });
});

describe("production double-assertion ratchet", () => {
  test("recognizes nested assertions, not strings or single assertions", () => {
    expect(
      doubleAssertionPositions(parseSource("x.ts", "const x = (value as unknown) as X;")),
    ).toHaveLength(1);
    expect(
      doubleAssertionPositions(parseSource("x.ts", 'const x = "as unknown as X";')),
    ).toHaveLength(0);
    expect(doubleAssertionPositions(parseSource("x.ts", "const x = value as X;"))).toHaveLength(0);
  });

  test("allows existing production assertions only within their per-file budgets", () => {
    const offenders = productionFiles.flatMap(({ file, ast }) =>
      doubleAssertionPositions(ast)
        .slice(productionDoubleAssertionBudget[file] ?? 0)
        .map((position) => describeLocation(ast, position)),
    );
    expect(offenders).toEqual([]);
  });

  test("lowers each per-file budget as soon as its assertions are removed", () => {
    const counts = Object.fromEntries(
      productionFiles
        .map(({ file, ast }) => [file, doubleAssertionPositions(ast).length] as const)
        .filter(([, count]) => count > 0),
    );
    expect(counts).toEqual(productionDoubleAssertionBudget);
  });
});

describe("boundary source guards", () => {
  test("scans the whole source tree", () => {
    expect(sources.length).toBeGreaterThanOrEqual(minimumSourceFiles);
    expect(productionFiles.length).toBeGreaterThanOrEqual(minimumProductionFiles);
  });

  test.each(rules.map((rule) => [rule.id, rule] as const))("%s", (_id, rule) => {
    const offenders = sources
      .filter((source) => rule.appliesTo(source.file))
      .flatMap((source) =>
        rule
          .violates(source.file, source.ast)
          .map((position) => describeLocation(source.ast, position)),
      );
    const report =
      offenders.length === 0
        ? ""
        : `${rule.id}: ${rule.rule}.\n${offenders.map((line) => `  ${line}`).join("\n")}`;
    expect(report).toBe("");
  });
});
