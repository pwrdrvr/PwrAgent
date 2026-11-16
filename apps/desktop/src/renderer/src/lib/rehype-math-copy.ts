type MathNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MathNode[];
  value?: string;
};

function hasClass(node: MathNode, name: string): boolean {
  return Array.isArray(node.properties?.className) && node.properties.className.includes(name);
}

function latexSource(node: MathNode): string | undefined {
  if (node.tagName === "annotation" && node.properties?.encoding === "application/x-tex") {
    return node.children?.map((child) => child.value ?? "").join("");
  }
  for (const child of node.children ?? []) {
    const source = latexSource(child);
    if (source !== undefined) return source;
  }
  return undefined;
}

/** Wrap only formula roots, rather than installing a React component for
 * every span in KaTeX's layout tree. Keep the original MathML and HTML intact. */
export function rehypeMathCopy() {
  return (tree: MathNode): void => {
    function visit(node: MathNode): void {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        const display = hasClass(child, "katex-display");
        if (display || hasClass(child, "katex")) {
          const latex = latexSource(child);
          if (latex !== undefined) {
            return {
              type: "element", tagName: "math-formula",
              properties: { dataLatex: latex, dataDisplay: display },
              children: [child],
            };
          }
        }
        visit(child);
        return child;
      });
    }
    visit(tree);
  };
}
