import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface ScannedSource {
  file: string;
  ast: ts.SourceFile;
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const nonSourcePrefixes = ["src/content/", "src/content.config.ts"];

function toRepositoryPath(path: string): string {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function walkTypeScript(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walkTypeScript(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
}

export function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

export function scanSourceTree(): ScannedSource[] {
  return walkTypeScript(join(repositoryRoot, "src"))
    .map(toRepositoryPath)
    .filter((file) => !nonSourcePrefixes.some((prefix) => file.startsWith(prefix)))
    .map((file) => ({
      file,
      ast: parseSource(file, readFileSync(join(repositoryRoot, file), "utf8")),
    }));
}

export function isProductionFile(file: string): boolean {
  return !file.startsWith("src/test/");
}

export function readRepositoryFile(file: string): string {
  return readFileSync(join(repositoryRoot, file), "utf8");
}

export function collectNodes(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

export function describeLocation(source: ts.SourceFile, position: number): string {
  const { line } = source.getLineAndCharacterOfPosition(position);
  const text = source.text.split("\n")[line]?.trim() ?? "";
  return `${source.fileName}:${line + 1}: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`;
}
