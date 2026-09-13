import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useLensScrollRestoration } from "../useLensScrollRestoration";

afterEach(cleanup);

function Lens(props: { lens: string; ready: boolean }) {
  const scroll = useLensScrollRestoration(props.lens, props.ready);
  return <div data-testid="scroll" {...scroll} />;
}

it("restores independent lens positions after their rows are ready", () => {
  const view = render(<Lens lens="inbox" ready />);
  const element = view.getByTestId("scroll");
  fireEvent.scroll(element, { target: { scrollTop: 240 } });
  view.rerender(<Lens lens="recents" ready />);
  expect(element.scrollTop).toBe(0);
  fireEvent.scroll(element, { target: { scrollTop: 80 } });
  view.rerender(<Lens lens="inbox" ready={false} />);
  fireEvent.scroll(element, { target: { scrollTop: 0 } });
  view.rerender(<Lens lens="inbox" ready />);
  expect(element.scrollTop).toBe(240);
  view.rerender(<Lens lens="inbox" ready />);
  expect(element.scrollTop).toBe(240);
  view.rerender(<Lens lens="recents" ready />);
  expect(element.scrollTop).toBe(80);
});
