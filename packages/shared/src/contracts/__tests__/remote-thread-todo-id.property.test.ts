import fc from "fast-check";
import { expect, it } from "vitest";
import {
  isRemoteThreadTodoId,
  ownerLocalThreadTodoId,
  parseRemoteThreadTodoId,
  remoteThreadTodoId,
} from "../thread-todos";

const text = fc.string({ minLength: 1, maxLength: 24, unit: "binary" });

// Oracle: a viewer's id names exactly one owner's card, and every reader
// recovers that owner and that owner-local id, whatever either holds.
it("recovers the owner and card from any viewer id", () => {
  fc.assert(fc.property(text, text, (instanceId, id) => {
    const viewerId = remoteThreadTodoId({ instanceId }, id);
    expect(isRemoteThreadTodoId(viewerId)).toBe(true);
    expect(parseRemoteThreadTodoId(viewerId)).toEqual({ instanceId, id });
    expect(ownerLocalThreadTodoId(viewerId, { instanceId })).toBe(id);
  }));
});

it("refuses another owner's card and leaves an owner-local id alone", () => {
  fc.assert(fc.property(text, text, text, (owner, other, id) => {
    fc.pre(owner !== other && !id.startsWith("remote-todo:"));
    expect(() => ownerLocalThreadTodoId(remoteThreadTodoId({ instanceId: other }, id), { instanceId: owner }))
      .toThrow("To-do owner does not match its target.");
    expect(ownerLocalThreadTodoId(id, { instanceId: owner })).toBe(id);
  }));
});

it("names a malformed viewer id rather than surfacing a decode error", () => {
  for (const id of ["remote-todo:", "remote-todo:peer", "remote-todo:%E0%A4:card", "remote-todo:peer:%E0%A4"]) {
    expect(() => parseRemoteThreadTodoId(id)).toThrow("Invalid remote to-do id.");
  }
});
