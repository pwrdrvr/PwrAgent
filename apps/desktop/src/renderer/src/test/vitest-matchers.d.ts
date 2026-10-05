import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import "vitest";

// jest-dom 7 augments Vitest's older Assertion interface. Vitest 5 reads
// custom matchers from Matchers so synchronous and asynchronous assertions
// retain their respective return types.
declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Module augmentation requires an interface.
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<T, R> {}
}
