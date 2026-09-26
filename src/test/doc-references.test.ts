import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const rootGuides = ["AGENTS.md", "ARCHITECTURE.md", "CONTEXT.md"];
const repositoryPathPrefixes = [
  "src/",
  "docs/",
  "e2e/",
  "scripts/",
  "deploy/",
  ".config/",
  ".github/",
];

function moduleReadmes(directory = "src"): string[] {
  return readdirSync(join(repositoryRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return path === "src/content" ? [] : moduleReadmes(path);
    return entry.name === "README.md" ? [path] : [];
  });
}

function headingAnchors(file: string): Set<string> {
  const text = readFileSync(join(repositoryRoot, file), "utf8");
  const headings = [...text.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading = ""]) =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[`*_]/g, "")
      .replace(/[^\p{L}\p{N}\- ]/gu, "")
      .replaceAll(" ", "-"),
  );
  const ids = [...text.matchAll(/id="([^"]+)"/g)].map(([, id = ""]) => id);
  return new Set([...headings, ...ids]);
}

function missingTarget(target: string, fragment: string | undefined): string | undefined {
  if (!existsSync(join(repositoryRoot, target))) return "missing file";
  if (fragment && target.endsWith(".md") && !headingAnchors(target).has(fragment)) {
    return "missing anchor";
  }
  return undefined;
}

function brokenReferences(file: string, text: string): string[] {
  const markdownLinks = [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map(([, link = ""]) => link)
    .filter((link) => !/^[a-z]+:/i.test(link) && !link.startsWith("#"))
    .map((link) => {
      const [path = "", fragment] = link.split("#");
      return { shown: link, target: normalize(join(dirname(file), path)), fragment };
    });
  const pathMentions = [...text.matchAll(/`([^`\s]+)`/g)]
    .map(([, mention = ""]) => mention)
    .filter(
      (mention) =>
        repositoryPathPrefixes.some((prefix) => mention.startsWith(prefix)) &&
        !/[<>*{}]/.test(mention),
    )
    .map((mention) => {
      const [path = "", fragment] = mention.split("#");
      return { shown: mention, target: path.replace(/\/$/, ""), fragment };
    });
  return [...markdownLinks, ...pathMentions].flatMap(({ shown, target, fragment }) => {
    const problem = missingTarget(target, fragment);
    return problem ? [`${file}: ${shown} (${problem})`] : [];
  });
}

describe("documentation references", () => {
  test("recognizes stale paths, links, and anchors but not placeholders", () => {
    expect(brokenReferences("AGENTS.md", "see `src/no-such-module/`")).toHaveLength(1);
    expect(brokenReferences("AGENTS.md", "see [x](docs/no-such.md)")).toHaveLength(1);
    expect(brokenReferences("AGENTS.md", "see [x](ARCHITECTURE.md#no-such-anchor)")).toHaveLength(
      1,
    );
    expect(
      brokenReferences("AGENTS.md", "see `src/test/<name>.test.ts` and `src/*/README.md`"),
    ).toEqual([]);
    expect(
      brokenReferences("AGENTS.md", "see [x](https://example.com) and `package.json`"),
    ).toEqual([]);
  });

  test("agent guides and module READMEs point at files and anchors that exist", () => {
    const files = [...rootGuides, ...moduleReadmes()];
    const broken = files.flatMap((file) =>
      brokenReferences(file, readFileSync(join(repositoryRoot, file), "utf8")),
    );
    expect(broken).toEqual([]);
  });

  test("architecture.toml docs and ADR links resolve", () => {
    const toml = readFileSync(join(repositoryRoot, "architecture.toml"), "utf8");
    const broken = [...toml.matchAll(/^\s*(?:docs|adr) = "([^"]+)"/gm)].flatMap(([, ref = ""]) => {
      const [target = "", fragment] = ref.split("#");
      const problem = missingTarget(target, fragment);
      return problem ? [`architecture.toml: ${ref} (${problem})`] : [];
    });
    expect(broken).toEqual([]);
  });
});
