import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";

const trackedCodeFiles = execFileSync(
  "git",
  ["ls-files", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

const codeFiles = [
  ...new Set([
    ...trackedCodeFiles,
    "src/adapters/web/admin/client-assets.ts",
    "src/test/code-comment-contract.test.ts",
  ]),
];

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function sourceFile(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
}

function comments(path: string, source: string): string[] {
  const parsed = sourceFile(path, source);
  const ranges = new Map<string, ts.CommentRange>();
  const collect = (items: ts.CommentRange[] | undefined) => {
    for (const item of items ?? []) ranges.set(`${item.pos}:${item.end}`, item);
  };
  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(source, node.getEnd()));
    node.forEachChild(visit);
  };
  visit(parsed);
  return [...ranges.values()].map((range) => source.slice(range.pos, range.end));
}

test("comment detection ignores comment-shaped string content", () => {
  expect(comments("fixture.ts", 'const url = "https://example.com"; // invalid')).toEqual([
    "// invalid",
  ]);
});

test("code contains no comments", () => {
  const violations = codeFiles.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return comments(path, source).map((comment) => `${path}: ${comment.slice(0, 80)}`);
  });
  expect(violations).toEqual([]);
});

test("embedded code contains no comments", () => {
  const violations = codeFiles.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const parsed = sourceFile(path, source);
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)) &&
        /^\s*(?:\/\/|\/\*|<!--)/m.test(node.text)
      ) {
        found.push(`${path}: ${node.text.match(/^\s*(?:\/\/|\/\*|<!--).*$/m)?.[0].trim()}`);
      }
      node.forEachChild(visit);
    };
    visit(parsed);
    return found;
  });
  expect(violations).toEqual([]);
});

test("Python scripts contain no comments beyond their interpreter directive", () => {
  const files = execFileSync("git", ["ls-files", "*.py"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  const violations = files.filter((path) => {
    const lines = readFileSync(path, "utf8").split("\n");
    return lines.some(
      (line, index) => /^\s*#/.test(line) && !(index === 0 && line.startsWith("#!")),
    );
  });
  expect(violations).toEqual([]);
});
