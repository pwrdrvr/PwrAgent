import { expect, it } from "vitest";
import { NavigationMetadataBudget } from "../navigation-metadata-budget";

it("bounds aggregate geometry across owners while allowing an atomic replacement", () => {
  const budget = new NavigationMetadataBudget(100, 100);
  const first = budget.begin("owner-a");
  first.reserve(60);
  first.commit();
  const second = budget.begin("owner-b");
  second.reserve(50);
  expect(() => second.commit()).toThrow("retained byte budget");
  second.dispose();
  expect(budget.usage()).toEqual({ retainedBytes: 60, transientBytes: 0 });
  const replacement = budget.begin("owner-a");
  replacement.reserve(80);
  expect(budget.usage()).toEqual({ retainedBytes: 60, transientBytes: 80 });
  replacement.commit();
  expect(budget.usage()).toEqual({ retainedBytes: 80, transientBytes: 0 });
});

it("bounds in-progress reads together and keeps cancelled backing charged until settlement", () => {
  const budget = new NavigationMetadataBudget(100, 100);
  const first = budget.begin("owner-a");
  const second = budget.begin("owner-b");
  first.reserve(60);
  expect(() => second.reserve(50)).toThrow("transient byte budget");
  budget.release("owner-a");
  expect(budget.usage().transientBytes).toBe(60);
  expect(() => first.commit()).toThrow("cancelled");
  first.dispose();
  second.reserve(50);
  second.commit();
  budget.release("owner-b");
  expect(budget.usage()).toEqual({ retainedBytes: 0, transientBytes: 0 });
});

it("releases abandoned cursor-generation backing without releasing earlier exact batches", () => {
  const budget = new NavigationMetadataBudget(100, 100);
  const read = budget.begin("exact");
  read.reserve(30);
  read.reserve(50);
  read.unreserve(50);
  expect(budget.usage().transientBytes).toBe(30);
  read.reserve(60);
  read.commit();
  expect(budget.usage().retainedBytes).toBe(90);
});

it("does not allow an older read to replace a newer resource generation", () => {
  const budget = new NavigationMetadataBudget(100, 100);
  const old = budget.begin("owner");
  old.reserve(20);
  const current = budget.begin("owner");
  current.reserve(30);
  current.commit();
  expect(() => old.commit()).toThrow("cancelled");
  old.dispose();
  expect(budget.usage()).toEqual({ retainedBytes: 30, transientBytes: 0 });
});
