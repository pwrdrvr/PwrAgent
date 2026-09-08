import { beforeEach, vi } from "vitest";

// Layout/population fixtures model an actively viewed map. Lifecycle tests
// supply their own focus and visibility transitions instead.
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
