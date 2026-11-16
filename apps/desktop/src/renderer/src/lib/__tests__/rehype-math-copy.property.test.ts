import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { rehypeMathCopy } from "../rehype-math-copy";

type Node = Parameters<ReturnType<typeof rehypeMathCopy>>[0];

describe("formula copy wrappers", () => {
  it("preserves every complete KaTeX root and its exact source, wrapping it once", () => {
    fc.assert(fc.property(fc.array(fc.record({ latex: fc.string(), display: fc.boolean() }), { maxLength: 12 }), (formulas) => {
      const originals: Node[] = formulas.map(({ latex, display }) => {
        const inline: Node = { type: "element", tagName: "span", properties: { className: ["katex"] }, children: [
          { type: "element", tagName: "annotation", properties: { encoding: "application/x-tex" }, children: [{ type: "text", value: latex }] },
        ] };
        return display ? { type: "element", tagName: "span", properties: { className: ["katex-display"] }, children: [inline] } : inline;
      });
      const tree: Node = { type: "root", children: originals };
      rehypeMathCopy()(tree);
      expect(tree.children).toHaveLength(formulas.length);
      for (let index = 0; index < formulas.length; index++) {
        const wrapper = tree.children![index];
        expect(wrapper.tagName).toBe("math-formula");
        expect(wrapper.properties).toEqual({ dataLatex: formulas[index].latex, dataDisplay: formulas[index].display });
        expect(wrapper.children).toHaveLength(1);
        expect(wrapper.children![0]).toBe(originals[index]);
      }
    }));
  });

  it("leaves ordinary text and unrendered errors alone", () => {
    const text: Node = { type: "text", value: "ordinary" };
    const error: Node = { type: "element", tagName: "span", properties: { className: ["katex-error"] }, children: [] };
    const tree: Node = { type: "root", children: [text, error] };
    rehypeMathCopy()(tree);
    expect(tree.children).toEqual([text, error]);
  });
});
