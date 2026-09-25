import ts from "typescript";
import { describe, expect, test } from "vitest";
import { THINKING_LEVELS } from "../settings/index.js";
import {
  collectNodes,
  describeLocation,
  isProductionFile,
  parseSource,
  scanSourceTree,
  type ScannedSource,
} from "./source-scan.js";

interface FactOwnerGuard {
  id: string;
  owner: string;
  ownerFiles: string[];
  find: (source: ts.SourceFile) => number[];
  copies: string[];
  legitimate: string[];
}

const minimumProductionFiles = 120;
const productionSources = scanSourceTree().filter((source) => isProductionFile(source.file));

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function outerParent(node: ts.Node): ts.Node {
  let current = node.parent;
  while (current && ts.isParenthesizedExpression(current)) current = current.parent;
  return current;
}

function normalized(node: ts.Node): string {
  return node.getText().replace(/\s+/g, "").replace(/\?\./g, ".");
}

function sameExpression(left: ts.Node, right: ts.Node): boolean {
  return normalized(unwrap(left)) === normalized(unwrap(right));
}

function onlyElement<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

function isCallTo(node: ts.Node, callee: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.getText() === callee;
}

function isStringLiteralLike(node: ts.Node): node is ts.StringLiteralLike {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function flattenBinary(node: ts.Node, operator: ts.SyntaxKind): ts.Node[] {
  const inner = unwrap(node);
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === operator) {
    return [...flattenBinary(inner.left, operator), ...flattenBinary(inner.right, operator)];
  }
  return [inner];
}

function isChainRoot(node: ts.Node, operator: ts.SyntaxKind): node is ts.BinaryExpression {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== operator) return false;
  const parent = outerParent(node);
  return !(ts.isBinaryExpression(parent) && parent.operatorToken.kind === operator);
}

const equalityOperators = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
]);
const inequalityOperators = new Set([
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function literalFragments(source: ts.SourceFile): { node: ts.Node; text: string }[] {
  return collectNodes(
    source,
    (node) =>
      isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node),
  ).map((node) => ({ node, text: (node as ts.LiteralLikeNode).text }));
}

function literalEndings(source: ts.SourceFile): { node: ts.Node; text: string }[] {
  return literalFragments(source).filter(
    ({ node }) => isStringLiteralLike(node) || ts.isTemplateTail(node),
  );
}

function fragmentPosition(node: ts.Node, match: RegExpExecArray | RegExpMatchArray): number {
  const rawIndex = node.getText().indexOf(match[0]);
  return node.getStart() + (rawIndex >= 0 ? rawIndex : 1 + (match.index ?? 0));
}

function literalsMatching(pattern: RegExp, pieces: typeof literalFragments) {
  return (source: ts.SourceFile) =>
    pieces(source).flatMap(({ node, text }) => {
      const match = pattern.exec(text);
      return match ? [fragmentPosition(node, match)] : [];
    });
}

function starts(nodes: ts.Node[]): number[] {
  return nodes.map((node) => node.getStart());
}

function errorFallbackParts(node: ts.ConditionalExpression) {
  const condition = unwrap(node.condition);
  if (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    condition.right.getText() === "Error"
  ) {
    return { subject: condition.left, message: node.whenTrue, fallback: node.whenFalse };
  }
  if (
    ts.isPrefixUnaryExpression(condition) &&
    condition.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const negated = unwrap(condition.operand);
    if (
      ts.isBinaryExpression(negated) &&
      negated.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      negated.right.getText() === "Error"
    ) {
      return { subject: negated.left, message: node.whenFalse, fallback: node.whenTrue };
    }
  }
  return undefined;
}

function isStringifiedByContext(node: ts.Node): boolean {
  const parent = outerParent(node);
  return ts.isTemplateSpan(parent) || isCallTo(parent, "String");
}

function stringifies(fallback: ts.Node, subject: ts.Node, conditional: ts.Node): boolean {
  const value = unwrap(fallback);
  if (isCallTo(value, "String")) {
    const argument = onlyElement(value.arguments);
    return argument !== undefined && sameExpression(argument, subject);
  }
  if (ts.isTemplateExpression(value)) {
    const span = onlyElement(value.templateSpans);
    return (
      value.head.text === "" &&
      span !== undefined &&
      span.literal.text === "" &&
      sameExpression(span.expression, subject)
    );
  }
  return sameExpression(value, subject) && isStringifiedByContext(conditional);
}

function findErrorMessageFallbacks(source: ts.SourceFile): number[] {
  return starts(
    collectNodes(source, (node) => {
      if (!ts.isConditionalExpression(node)) return false;
      const parts = errorFallbackParts(node);
      if (!parts) return false;
      const message = unwrap(parts.message);
      return (
        ts.isPropertyAccessExpression(message) &&
        message.name.text === "message" &&
        sameExpression(message.expression, parts.subject) &&
        stringifies(parts.fallback, parts.subject, node)
      );
    }),
  );
}

type RecordTerm = "object" | "notNull" | "notArray";

function typeofObjectSubject(term: ts.BinaryExpression): ts.Node | undefined {
  if (!equalityOperators.has(term.operatorToken.kind)) return undefined;
  const [typeofSide, other] = ts.isTypeOfExpression(unwrap(term.left))
    ? [unwrap(term.left), unwrap(term.right)]
    : [unwrap(term.right), unwrap(term.left)];
  if (!ts.isTypeOfExpression(typeofSide)) return undefined;
  return isStringLiteralLike(other) && other.text === "object" ? typeofSide.expression : undefined;
}

function notNullSubject(term: ts.BinaryExpression): ts.Node | undefined {
  if (!inequalityOperators.has(term.operatorToken.kind)) return undefined;
  if (unwrap(term.right).kind === ts.SyntaxKind.NullKeyword) return term.left;
  if (unwrap(term.left).kind === ts.SyntaxKind.NullKeyword) return term.right;
  return undefined;
}

function negatedArraySubject(term: ts.PrefixUnaryExpression): ts.Node | undefined {
  const operand = unwrap(term.operand);
  if (isCallTo(operand, "Array.isArray") && operand.arguments.length === 1) {
    return operand.arguments[0];
  }
  if (
    ts.isBinaryExpression(operand) &&
    operand.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    operand.right.getText() === "Array"
  ) {
    return operand.left;
  }
  if (ts.isPrefixUnaryExpression(operand) && operand.operator === ts.SyntaxKind.ExclamationToken) {
    return operand.operand;
  }
  return undefined;
}

function classifyRecordTerm(term: ts.Node): { kind: RecordTerm; subject: ts.Node } | undefined {
  if (ts.isBinaryExpression(term)) {
    const object = typeofObjectSubject(term);
    if (object) return { kind: "object", subject: object };
    const notNull = notNullSubject(term);
    return notNull ? { kind: "notNull", subject: notNull } : undefined;
  }
  if (ts.isPrefixUnaryExpression(term) && term.operator === ts.SyntaxKind.ExclamationToken) {
    const subject = negatedArraySubject(term);
    if (!subject) return undefined;
    const inner = unwrap(term.operand);
    return ts.isPrefixUnaryExpression(inner)
      ? { kind: "notNull", subject }
      : { kind: "notArray", subject };
  }
  if (isCallTo(term, "Boolean")) {
    const subject = onlyElement(term.arguments);
    if (subject) return { kind: "notNull", subject };
  }
  if (ts.isIdentifier(term) || ts.isPropertyAccessExpression(term)) {
    return { kind: "notNull", subject: term };
  }
  return undefined;
}

function findRecordChecks(source: ts.SourceFile): number[] {
  return starts(
    collectNodes(source, (node) => {
      if (!isChainRoot(node, ts.SyntaxKind.AmpersandAmpersandToken)) return false;
      const kindsBySubject = new Map<string, Set<RecordTerm>>();
      for (const term of flattenBinary(node, ts.SyntaxKind.AmpersandAmpersandToken)) {
        const classified = classifyRecordTerm(term);
        if (!classified) continue;
        const key = normalized(unwrap(classified.subject));
        const kinds = kindsBySubject.get(key) ?? new Set<RecordTerm>();
        kinds.add(classified.kind);
        kindsBySubject.set(key, kinds);
      }
      return [...kindsBySubject.values()].some((kinds) => kinds.size === 3);
    }),
  );
}

const thinkingLevels = new Set<string>(THINKING_LEVELS);
const piSpecificThinkingLevels = new Set(["minimal", "xhigh"]);
const levelAlternation = THINKING_LEVELS.join("|");
const quotedLevel = `[\`'"]?(?:${levelAlternation})[\`'"]?`;
const levelSeparator = String.raw`\s*(?:,|、|\||\/|\bor\b|\band\b|或)\s*`;
const levelToken = new RegExp(String.raw`\b(?:${levelAlternation})\b`, "g");
const proseLevelList = new RegExp(
  String.raw`(?<![\w-])${quotedLevel}(?:${levelSeparator}${quotedLevel})+(?![\w-])`,
  "g",
);

function levelValue(node: ts.Node): string | undefined {
  const value = unwrap(node);
  if (isStringLiteralLike(value)) return value.text;
  if (ts.isLiteralTypeNode(value) && isStringLiteralLike(value.literal)) return value.literal.text;
  const onlyArgument = ts.isCallExpression(value) ? onlyElement(value.arguments) : undefined;
  if (onlyArgument) {
    const argument = unwrap(onlyArgument);
    return isStringLiteralLike(argument) ? argument.text : undefined;
  }
  if (ts.isBinaryExpression(value) && equalityOperators.has(value.operatorToken.kind)) {
    return levelValue(value.right) ?? levelValue(value.left);
  }
  return undefined;
}

function memberName(node: ts.Node): string | undefined {
  if (
    (ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isPropertySignature(node)) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  return undefined;
}

function levelGroup(node: ts.Node): (string | undefined)[] | undefined {
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(levelValue);
  if (ts.isUnionTypeNode(node)) return node.types.map(levelValue);
  if (ts.isObjectLiteralExpression(node)) return node.properties.map(memberName);
  if (ts.isTypeLiteralNode(node)) return node.members.map(memberName);
  if (ts.isCaseBlock(node)) {
    return node.clauses.map((clause) =>
      ts.isCaseClause(clause) ? levelValue(clause.expression) : undefined,
    );
  }
  if (isChainRoot(node, ts.SyntaxKind.BarBarToken)) {
    return flattenBinary(node, ts.SyntaxKind.BarBarToken).map(levelValue);
  }
  return undefined;
}

function isThinkingLevelList(values: Iterable<string | undefined>): boolean {
  const levels = new Set([...values].filter((value) => value && thinkingLevels.has(value)));
  return levels.size >= 2 && [...levels].some((level) => piSpecificThinkingLevels.has(level!));
}

function findThinkingLevelLists(source: ts.SourceFile): number[] {
  const groups = collectNodes(source, (node) => {
    const group = levelGroup(node);
    return group !== undefined && isThinkingLevelList(group);
  });
  const prose = literalFragments(source).flatMap(({ node, text }) =>
    [...text.matchAll(proseLevelList)]
      .filter((match) => isThinkingLevelList(match[0].match(levelToken) ?? []))
      .map((match) => fragmentPosition(node, match)),
  );
  return [...starts(groups), ...prose];
}

function exportedToolNames(sources: ScannedSource[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const { file, ast } of sources) {
    for (const statement of ast.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text.endsWith("_TOOL") &&
          declaration.initializer &&
          isStringLiteralLike(declaration.initializer)
        ) {
          owners.set(declaration.initializer.text, file);
        }
      }
    }
  }
  return owners;
}

const toolNameOwners = exportedToolNames(productionSources);
const toolishName = /(?:^|\.)\w*(?:name|Name|tool|Tool|tools|Tools)$/;

function holderName(node: ts.Node): string | undefined {
  let current = outerParent(node);
  while (
    current &&
    (ts.isNewExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.parent;
  }
  if (!current) return undefined;
  if (ts.isPropertyAssignment(current) || ts.isVariableDeclaration(current)) {
    return current.name.getText();
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return current.left.getText();
  }
  return undefined;
}

function isToolNamePosition(literal: ts.Node): boolean {
  const parent = outerParent(literal);
  if (ts.isPropertyAssignment(parent)) {
    return parent.name === literal || toolishName.test(parent.name.getText());
  }
  if (
    ts.isBinaryExpression(parent) &&
    (equalityOperators.has(parent.operatorToken.kind) ||
      inequalityOperators.has(parent.operatorToken.kind))
  ) {
    const other = unwrap(parent.left) === literal ? parent.right : parent.left;
    return toolishName.test(normalized(unwrap(other)));
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    return parent.arguments?.some((argument) => unwrap(argument) === literal) ?? false;
  }
  if (ts.isElementAccessExpression(parent)) return unwrap(parent.argumentExpression) === literal;
  if (ts.isArrayLiteralExpression(parent)) return /tool/i.test(holderName(parent) ?? "");
  if (ts.isCaseClause(parent)) {
    return toolishName.test(normalized(unwrap(parent.parent.parent.expression)));
  }
  return false;
}

function findToolNameLiterals(source: ts.SourceFile): number[] {
  return starts(
    collectNodes(source, (node) => {
      if (!isStringLiteralLike(node)) return false;
      const owner = toolNameOwners.get(node.text);
      return owner !== undefined && owner !== source.fileName && isToolNamePosition(node);
    }),
  );
}

const guards: FactOwnerGuard[] = [
  {
    id: "error-message-fallback",
    owner: "errorMessage in src/unknown-values.ts",
    ownerFiles: ["src/unknown-values.ts"],
    find: findErrorMessageFallbacks,
    copies: [
      "const text = error instanceof Error ? error.message : String(error);",
      "const text = err instanceof Error ? err.message : String(err);",
      "const text = (e instanceof Error) ? e.message : `${e}`;",
      "const text = `failed: ${error instanceof Error ? error.message : error}`;",
      "const text = String(cause instanceof Error ? cause.message : cause);",
      "const text = !(reason instanceof Error) ? String(reason) : reason.message;",
      "const text =\n  result.error instanceof Error\n    ? result.error.message\n    : String(result.error);",
    ],
    legitimate: [
      "const text = errorMessage(error);",
      'import { errorMessage } from "../unknown-values.js";',
      "const wrapped = err instanceof Error ? err : new Error(String(err));",
      'const text = error instanceof Error ? error.message : "Could not deliver task update.";',
      'const kind = error instanceof Error ? error.name : "Error";',
      "const text = a instanceof Error ? b.message : String(a);",
      "const detail = error instanceof Error ? error.message : error;",
    ],
  },
  {
    id: "record-check",
    owner: "isRecord in src/unknown-values.ts",
    ownerFiles: ["src/unknown-values.ts"],
    find: findRecordChecks,
    copies: [
      'const ok = typeof value === "object" && value !== null && !Array.isArray(value);',
      'const ok = value !== null && typeof value === "object" && !Array.isArray(value);',
      'const ok = data.env && typeof data.env === "object" && !Array.isArray(data.env);',
      "const ok = !!x && typeof x == 'object' && !(x instanceof Array);",
      'const ok =\n  null !== input &&\n  typeof input === "object" &&\n  !Array.isArray(input) &&\n  "id" in input;',
      'function isPlainRecord(v: unknown) {\n  return typeof v === "object" && v != null && !Array.isArray(v);\n}',
    ],
    legitimate: [
      "const ok = isRecord(value);",
      'import { isRecord } from "../unknown-values.js";',
      'const ok = value !== null && typeof value === "object";',
      'const ok = typeof a === "object" && b !== null && !Array.isArray(c);',
      'const ok = typeof value === "object" || Array.isArray(value);',
    ],
  },
  {
    id: "office-log-filename",
    owner: "OFFICE_LOG_FILENAME in src/office/index.ts",
    ownerFiles: ["src/office/index.ts"],
    find: literalsMatching(/^(?:\S*\/)?log\.jsonl$/, literalEndings),
    copies: [
      'const path = join(dir, "log.jsonl");',
      "const path = join(dir, 'log.jsonl');",
      "const path = `${dir}/log.jsonl`;",
      "const path = `log.jsonl`;",
      'const path = "workspace/office/log.jsonl";',
    ],
    legitimate: [
      "const path = join(dir, OFFICE_LOG_FILENAME);",
      'const hint = "search log.jsonl before answering";',
      "const hint = `tail -30 log.jsonl | jq -c .`;",
      "const hint = `Use \\`log.jsonl\\` for grep-style history.`;",
    ],
  },
  {
    id: "unexpected-json-shape",
    owner: "the JSON guard failure kinds in src/file-guards.ts",
    ownerFiles: ["src/file-guards.ts"],
    find: literalsMatching(/unexpected\s+JSON\s+shape/i, literalFragments),
    copies: [
      'const same = detail === "unexpected JSON shape";',
      "const text = `file has unexpected JSON shape: ${path}`;",
      "const text = 'Unexpected JSON shape';",
    ],
    legitimate: [
      "const text = UNEXPECTED_JSON_SHAPE;",
      'const same = failure.kind === "shape";',
      'const text = "unexpected JSON";',
    ],
  },
  {
    id: "control-input-custom-type",
    owner: "CONTROL_INPUT_CUSTOM_TYPE in src/sessions/types.ts",
    ownerFiles: ["src/sessions/types.ts"],
    find: literalsMatching(/^mikan\.control_input$/, literalFragments),
    copies: [
      'const same = entry.customType === "mikan.control_input";',
      "await store.appendCustomEntry('mikan.control_input', {});",
      "const type = `mikan.control_input`;",
    ],
    legitimate: [
      "await store.appendCustomEntry(CONTROL_INPUT_CUSTOM_TYPE, {});",
      'const text = "records a mikan.control_input entry first";',
      'const type = "mikan.control";',
    ],
  },
  {
    id: "google-vault-credential-files",
    owner: "GOOGLE_VAULT_CREDENTIAL_FILES in src/vault/index.ts",
    ownerFiles: ["src/vault/index.ts"],
    find: literalsMatching(
      /^(?:\S*[/=~])?(?:gws\.json|gcloud-adc\.json|\.config\/gws\/credentials\.json|\.config\/gcloud\/application_default_credentials\.json)$/,
      literalEndings,
    ),
    copies: [
      'const file = { relativePath: "gws.json" };',
      "const file = 'gcloud-adc.json';",
      "const target = guestHomePath('.config/gws/credentials.json');",
      'const target = "/root/.config/gcloud/application_default_credentials.json";',
      "const env = `GOOGLE_APPLICATION_CREDENTIALS=${home}/.config/gcloud/application_default_credentials.json`;",
    ],
    legitimate: [
      "const target = GOOGLE_VAULT_CREDENTIAL_FILES.cloudSdk.targetPath;",
      'const text = "store the credential as gws.json in the vault";',
      'const file = "credentials.json";',
      'const target = guestHomePath(".config/gh");',
    ],
  },
  {
    id: "tool-label-parameter",
    owner: "LABEL_PARAMETER in src/harness/tools/host-fn-tool.ts",
    ownerFiles: ["src/harness/tools/host-fn-tool.ts"],
    find: literalsMatching(/brief\s+description\s+of\s+this\s+action/i, literalFragments),
    copies: [
      'const label = Type.String({ description: "Brief description of this action (shown to user)" });',
      "const label = Type.String({ description: 'brief description of this action' });",
    ],
    legitimate: ["const schema = { label: LABEL_PARAMETER };", 'const text = "Brief description";'],
  },
  {
    id: "tool-name-literal",
    owner: "the module that exports the tool name constant (export const *_TOOL)",
    ownerFiles: [],
    find: findToolNameLiterals,
    copies: [
      'const bot = requireSlackBot("slack_blockkit");',
      'const keep = tool.name !== "start_task";',
      'const same = "task_status" === toolName;',
      "const tool = { name: 'jev_browser' };",
      'const profile = { tools: ["read", "bash", "jev"] };',
      "const same = toolName === `generate_image`;",
      'switch (call.name) {\n  case "github_pr":\n    break;\n}',
      'const renderer = renderers["slack_blockkit"];',
      'const finalResponseTools = new Set(["slack_blockkit"]);',
    ],
    legitimate: [
      'type SlackAutoReplyMode = "off" | "on" | "jev";',
      'const icon = autoReplyMode === "jev" ? a : b;',
      'switch (value) {\n  case "jev":\n    break;\n}',
      'report(error, { surface: "task_status" });',
      'record({ caller: "jev_browser" });',
      'const text = "Call start_task alone, without other tools in the same batch.";',
      "const tool = { name: JEV_TOOL };",
      'import { JEV_TOOL } from "./tools/jev.js";',
      'const provider = { aliases: ["github", "github_oauth"], id: "github_pat" };',
    ],
  },
  {
    id: "thinking-level-list",
    owner: "THINKING_LEVELS / isThinkingLevel in src/settings/index.ts",
    ownerFiles: ["src/settings/index.ts"],
    find: findThinkingLevelLists,
    copies: [
      'const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];',
      "const levels = new Set(['off', 'minimal', 'low']);",
      'type Level = "minimal" | "low" | "medium" | "high" | "xhigh";',
      "const keys = { off: true, minimal: true, low: true, xhigh: true };",
      "const schema = Type.Union([Type.Literal('minimal'), Type.Literal('xhigh')]);",
      'const text = "請使用 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。";',
      'const ok = level === "minimal" || level === "low" || level === "xhigh";',
      'switch (level) {\n  case "minimal":\n  case "xhigh":\n    break;\n}',
    ],
    legitimate: [
      "const ok = isThinkingLevel(value);",
      "const choices = THINKING_LEVELS.map((level) => `\\`${level}\\``);",
      'const profile = { thinkingLevel: "high" };',
      'type Quality = "low" | "medium" | "high";',
      'type SlackAutoReplyMode = "off" | "on" | "jev";',
      'const text = "Keep a minimal diff and a low risk profile.";',
    ],
  },
];

function findInSnippet(guard: FactOwnerGuard, snippet: string): number[] {
  return guard.find(parseSource("snippet.ts", snippet));
}

describe("fact-owner guard patterns", () => {
  test("every guard brings copies and legitimate spellings", () => {
    const missing = guards.filter(
      (guard) => guard.copies.length === 0 || guard.legitimate.length === 0,
    );
    expect(missing.map((guard) => guard.id)).toEqual([]);
  });

  test("each guard matches a copy however it is spelled", () => {
    const missed = guards.flatMap((guard) =>
      guard.copies
        .filter((copy) => findInSnippet(guard, copy).length === 0)
        .map((copy) => `${guard.id} misses:\n${copy}`),
    );
    expect(missed.join("\n\n")).toBe("");
  });

  test("each guard leaves callers, imports, prose, and different facts alone", () => {
    const flagged = guards.flatMap((guard) =>
      guard.legitimate
        .filter((line) => findInSnippet(guard, line).length > 0)
        .map((line) => `${guard.id} wrongly matches:\n${line}`),
    );
    expect(flagged.join("\n\n")).toBe("");
  });

  test("each owner file still declares the fact it owns", () => {
    const quiet = guards.flatMap((guard) =>
      guard.ownerFiles
        .filter((file) => {
          const source = productionSources.find((candidate) => candidate.file === file);
          return !source || guard.find(source.ast).length === 0;
        })
        .map((file) => `${guard.id}: ${file} no longer matches its own pattern`),
    );
    expect(quiet).toEqual([]);
  });

  test("tool name owners are discovered from their exporting modules", () => {
    expect(toolNameOwners.size).toBeGreaterThanOrEqual(12);
    expect([...toolNameOwners.keys()]).toEqual(
      expect.arrayContaining([
        "start_task",
        "task_status",
        "slack_blockkit",
        "jev",
        "jev_browser",
        "generate_image",
        "github_read",
        "github_pr",
      ]),
    );
  });
});

describe("fact-owner source guards", () => {
  test("scans the production source tree", () => {
    expect(productionSources.length).toBeGreaterThanOrEqual(minimumProductionFiles);
  });

  test.each(guards.map((guard) => [guard.id, guard] as const))(
    "%s has no copy outside its owner",
    (_id, guard) => {
      const offenders = productionSources
        .filter((source) => !guard.ownerFiles.includes(source.file))
        .flatMap((source) =>
          guard.find(source.ast).map((position) => describeLocation(source.ast, position)),
        );
      const report =
        offenders.length === 0
          ? ""
          : `${guard.id}: use ${guard.owner} instead of restating it.\n${offenders.map((line) => `  ${line}`).join("\n")}`;
      expect(report).toBe("");
    },
  );
});
