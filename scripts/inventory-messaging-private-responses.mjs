import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const baseline = "b54346c56247fef9e6ee8c925aad5ea37a37595c";
const directory = ".local/pwr-149-private/inventory";
const core = "apps/desktop/src/main/messaging/core/";
const controller = `${core}messaging-controller.ts`;
const router = `${core}messaging-backend-event-router.ts`;
const retired = ["privateReplyCompletionTurnKeys", "terminalPrivateResponseTurnKeys", "privateResponseFallbackTurnKeys", "attemptedPrivateResponseFallbackTurnKeys", "heldPrivateResponseFallbackTextByTurnKey"];
const owners = ["admitTurnInput", "dispose", "rememberAgentMessagingOrigin", "forgetAgentMessagingOrigin", "isTerminalPrivateResponseTurn", "isPrivateResponseFallbackTurn", "isPrivateReplyCompletionTurn", "handlePrivateReplyCallback", "reconcileQueuedAgentMessagingOrigin", "deliverPrivateResponseFallback", "sendPrivateResponseFromAgentMessagingOrigin", "backendEventHost"];
mkdirSync(directory, { recursive: true });
// Keep the full checker-backed audit, including inline/named casts, spies,
// Object.assign, prototypes, stand-ins, readonly/optional ports and try reads.
execFileSync(process.execPath, ["scripts/inventory-messaging-controller.mjs", "--output", directory], { stdio: ["ignore", "ignore", "inherit"] });
const source = (file, previous) => ts.createSourceFile(file, previous
  ? execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
  : readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const methods = file => file.statements.find(ts.isClassDeclaration).members.filter(ts.isMethodDeclaration);
const normalize = text => text.replace(/\s+/g, "");
function awaits(method) {
  const result = [];
  function visit(node) {
    if (ts.isAwaitExpression(node)) result.push(normalize(node.getText()));
    ts.forEachChild(node, visit);
  }
  visit(method);
  return result;
}
const preserved = [];
for (const file of [controller, router]) {
  const before = methods(source(file, true));
  const afterSource = source(file, false);
  const after = methods(afterSource);
  for (const old of before) {
    const current = after.find(method => method.name.getText() === old.name.getText());
    if (!current) throw new Error(`Missing owner method ${old.name.getText()}`);
    if (JSON.stringify(awaits(old)) !== JSON.stringify(awaits(current))) throw new Error(`Awaited effect/order changed: ${old.name.getText()}`);
    preserved.push({ file, method: old.name.getText(), awaits: awaits(current) });
    if (file === controller && !owners.includes(old.name.getText()) && normalize(old.getText()) !== normalize(current.getText())) throw new Error(`Unrelated method changed: ${old.name.getText()}`);
  }
  for (const name of retired) if (afterSource.text.includes(name)) throw new Error(`Retired facade state remains: ${name}`);
}
const read = name => JSON.parse(readFileSync(`${directory}/${name}.json`, "utf8"));
const privateRecord = record => /privateReply|PrivateReply|privateResponse|PrivateResponse/.test(record.text ?? record.name ?? "")
  || owners.some(owner => record.owner === `MessagingController.${owner}`);
const evidence = { baseline, awaitsPreserved: preserved, effects: read("effects").filter(privateRecord), seams: read("seams").filter(privateRecord), ports: read("ports").filter(privateRecord) };
writeFileSync(`${directory}/private-response.json`, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ baseline, methodsWithIdenticalAwaitOrder: preserved.length, privateEffects: evidence.effects.length, privateSeams: evidence.seams.length, privatePorts: evidence.ports.length, retiredTurnCollections: retired.length, requestClaimOwner: "MessagingPrivateReplyClaims", warnings: [] }));
