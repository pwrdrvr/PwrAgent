import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// Reproducible source/checker evidence; only counts go to stdout.
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const output = argument("--output", ".local/pwr-149/inventory");
const ref = argument("--ref");
const roots = ["apps/desktop/src", "packages/owner-core/src", "packages/messaging"];
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trimEnd();
const files = (ref
  ? git("ls-tree", "-r", "--name-only", ref, "--", ...roots)
  : execFileSync("rg", ["--files", ...roots, "-g", "*.ts", "-g", "*.tsx"], { encoding: "utf8" })
).trim().split("\n").filter(file => /\.tsx?$/.test(file));
const historical = new Map();
if (ref) {
  for (const file of git("diff", "--name-only", ref, "--", ...roots).split("\n")) {
    if (files.includes(file)) historical.set(path.resolve(file), git("show", `${ref}:${file}`));
  }
}
const config = ts.readConfigFile("apps/desktop/tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, "apps/desktop");
const host = ts.createCompilerHost(parsed.options);
const read = host.readFile.bind(host);
host.readFile = file => historical.get(path.resolve(file)) ?? read(file);
const program = ts.createProgram(files, { ...parsed.options, noEmit: true }, host);
const checker = program.getTypeChecker();
const controllerPath = "apps/desktop/src/main/messaging/core/messaging-controller.ts";
const baselineRef = "f5ce854b255650cba3a22eb6e4b741c0fdc3c53d";
const baselineSource = ts.createSourceFile(controllerPath, git("show", `${baselineRef}:${controllerPath}`), ts.ScriptTarget.Latest, true);
const baselineController = baselineSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingController");
const source = program.getSourceFile(controllerPath);
const controller = source?.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingController");
if (!controller) throw new Error("Missing MessagingController");
const memberNames = new Set(controller.members.filter(node => node.name).map(node => node.name.getText(source)));
// Retain moved names after extraction so obsolete facade casts remain visible.
for (const node of baselineController.members) if (node.name) memberNames.add(node.name.getText(baselineSource));
const collections = new Set(["set", "add", "delete", "clear", "push", "splice", "shift", "unshift"]);
const scope = node => {
  const names = [];
  for (let p = node; p; p = p.parent) {
    if ((ts.isFunctionLike(p) || ts.isClassDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) && p.name) names.unshift(p.name.getText());
    if (ts.isConstructorDeclaration(p)) names.unshift("constructor");
  }
  return names.join(".");
};
const site = node => {
  const file = node.getSourceFile();
  return { file: file.fileName, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, start: node.getStart(file), end: node.end };
};
const declaration = node => checker.getSymbolAtLocation(node)?.declarations?.map(d => ({ ...site(d), owner: scope(d) })) ?? [];
const type = node => checker.typeToString(checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation);
const ancestors = (node, predicate) => {
  const result = [];
  for (let p = node.parent; p; p = p.parent) if (predicate(p)) result.unshift(site(p));
  return result;
};
const record = node => ({ ...site(node), owner: scope(node), text: node.getText(),
  branches: ancestors(node, n => ts.isIfStatement(n) || ts.isSwitchStatement(n) || ts.isConditionalExpression(n)),
  catches: ancestors(node, ts.isTryStatement),
});
const members = controller.members.map(node => ({ ...site(node), name: node.name?.getText() ?? "constructor", kind: ts.SyntaxKind[node.kind],
  type: node.name ? type(node.name) : undefined, text: node.getText(),
}));
const effects = [], references = [], seams = [], ports = [], optionality = [];
const inMessaging = file => /\/messaging\/core\//.test(file) || /thread-turn-queue/.test(file);
for (const fileName of files) {
  const file = program.getSourceFile(fileName);
  if (!file || file.parseDiagnostics.length) throw new Error(`Missing or invalid source: ${fileName}`);
  function visit(node) {
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    if (name && memberNames.has(name)) references.push({ ...record(node), name, declarations: declaration(node) });
    if (inMessaging(fileName)) {
      const kind = ts.isCallExpression(node) ? "call" : ts.isAwaitExpression(node) ? "await"
        : ts.isReturnStatement(node) ? "return" : ts.isThrowStatement(node) ? "throw"
        : ts.isTryStatement(node) ? "exception-boundary"
        : ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node) ? "branch"
        : ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? "assignment"
        : ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? "read" : undefined;
      if (kind) effects.push({ ...record(node), kind,
        mutation: ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && collections.has(node.expression.name.text),
        declarations: ts.isPropertyAccessExpression(node) ? declaration(node.name) : ts.isCallExpression(node) ? declaration(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression) : undefined,
      });
      if (ts.isNewExpression(node) || ts.isGetAccessorDeclaration(node)) ports.push({ ...record(node), type: type(node) });
    }
    if (fileName.includes("__tests__") || fileName.endsWith(".test.ts")) {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const value = checker.getTypeAtLocation(node);
        const names = checker.getPropertiesOfType(value).map(p => p.name);
        if (names.some(n => memberNames.has(n)) || /MessagingController|Registry|Host|Members/.test(node.type.getText())) seams.push({ ...record(node), kind: "cast", members: names,
          namedType: value.aliasSymbol?.declarations?.map(site),
        });
      }
      if (ts.isCallExpression(node) && /spyOn|Object\.(assign|create|setPrototypeOf)/.test(node.expression.getText())) seams.push({ ...record(node), kind: "spy-override-prototype" });
      if (ts.isPropertyAccessExpression(node) && node.name.text === "prototype") seams.push({ ...record(node.parent), kind: "prototype" });
      if (ts.isObjectLiteralExpression(node) && node.properties.some(p => p.name && memberNames.has(p.name.getText().replaceAll('"', "")))) seams.push({ ...record(node), kind: "object-stand-in" });
    }
    if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && /Messaging.*(?:Store|Host|Context|Options|Bridge)|Registry.*(?:Store|Host|Context)/.test(node.name.text)) {
      optionality.push({ ...site(node), name: node.name.text, members: checker.getPropertiesOfType(checker.getTypeAtLocation(node)).map(p => ({ name: p.name,
        readonly: p.declarations?.some(d => d.modifiers?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword)) ?? false,
        optional: Boolean(p.flags & ts.SymbolFlags.Optional), type: checker.typeToString(checker.getTypeOfSymbolAtLocation(p, node), node, ts.TypeFormatFlags.NoTruncation),
      })) });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}
const summary = { command: "node scripts/inventory-messaging-controller.mjs", ref: git("rev-parse", ref ?? "HEAD"), files: files.length,
  members: members.length, fields: members.filter(m => m.kind === "PropertyDeclaration").length,
  methods: members.filter(m => m.kind === "MethodDeclaration").length,
  effects: effects.length, references: references.length, seams: seams.length, ports: ports.length, optionality: optionality.length,
  syntaxFailures: 0, warnings: [],
};
if (process.argv.includes("--verify-router-move")) {
  const router = program.getSourceFile("apps/desktop/src/main/messaging/core/messaging-backend-event-router.ts");
  const owner = router.statements.find(ts.isClassDeclaration);
  const normalize = text => text.replace(/\s+/g, "");
  const comparisons = ["handleBackendEvent", "handleBackendEventNow", "waitForPendingTurnFailureHandlers"].map(name => {
    const before = baselineController.members.find(node => node.name?.getText() === name);
    const after = owner.members.find(node => node.name?.getText() === name);
    const restored = after.body.getText()
      .replaceAll("this.context.host().", "this.")
      .replaceAll("this.context.store", "this.options.store")
      .replaceAll("this.context.now", "this.now")
      .replaceAll("this.context.logger", "this.logger")
      .replaceAll("threadKeyForBinding(binding)", "this.threadKeyForBinding(binding)");
    const identical = normalize(before.body.getText()) === normalize(restored);
    if (!identical) throw new Error(`Moved method differs from baseline: ${name}`);
    return { name, identical };
  });
  summary.routerMove = comparisons;
  const changedRetainedMethods = [];
  for (const before of baselineController.members) {
    if (!ts.isMethodDeclaration(before)) continue;
    const name = before.name.getText();
    if (["handleBackendEvent", "handleBackendEventNow", "waitForPendingTurnFailureHandlers", "dispose"].includes(name)) continue;
    const after = controller.members.find(node => node.name?.getText() === name);
    if (!after || normalize(before.getText()) !== normalize(after.getText())) changedRetainedMethods.push(name);
  }
  if (changedRetainedMethods.length) throw new Error(`Unrelated controller methods changed: ${changedRetainedMethods.join(", ")}`);
  summary.changedRetainedMethods = changedRetainedMethods;
}
mkdirSync(output, { recursive: true });
for (const [name, value] of Object.entries({ summary, members, effects, references, seams, ports, optionality })) writeFileSync(path.join(output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
console.log(JSON.stringify(summary));
