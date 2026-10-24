import {
  advanceIncrementalParse,
  buildTransform,
  type AdvanceResult,
  type IncrementalParseState,
} from "@ai-markdown/engine";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, memo, useRef } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import type { Options } from "react-markdown";
import { visit } from "unist-util-visit";

type IncrementalMarkdownProps = Pick<Options,
  "children" | "components" | "remarkPlugins" | "rehypePlugins"
> & {
  mathFlow: boolean;
  urlTransform: NonNullable<Options["urlTransform"]>;
};

const MarkdownBlock = memo(function MarkdownBlock(props: {
  node: AdvanceResult["hast"]["children"][number];
  components: Options["components"];
  urlTransform: NonNullable<Options["urlTransform"]>;
}) {
  // Render a private tree; URL filtering and raw-HTML escaping must not mutate
  // the engine's retained prefix. Stable prefix nodes skip this entire pass.
  const tree: AdvanceResult["hast"] = { type: "root", children: [structuredClone(props.node)] };
  visit(tree, buildTransform({
    allowedElements: undefined,
    allowElement: undefined,
    disallowedElements: undefined,
    skipHtml: false,
    unwrapDisallowed: false,
    urlTransform: props.urlTransform,
  }));
  return toJsxRuntime(tree, {
    Fragment,
    components: props.components,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  });
});

// Retain one document lineage per mounted parser owner.
// Use PwrAgent's exact plugin chain, with no AI Markdown UI/preprocessors.
// Its transformers are block-local. A new document-global transformer needs
// splice-equivalence coverage or must disable prefix reuse.
export function IncrementalMarkdown(props: IncrementalMarkdownProps) {
  const previous = useRef<IncrementalParseState | null>(null);
  const result = advanceIncrementalParse(previous.current, props.children ?? "", {
    remarkPlugins: props.remarkPlugins,
    rehypePlugins: props.rehypePlugins,
    remarkRehypeOptions: undefined,
    depsKey: [props.remarkPlugins, props.rehypePlugins],
    defListEnabled: false,
    gfmTaskListItems: true,
    mathFlow: props.mathFlow,
  });
  previous.current = result.nextState;

  return result.hast.children.map((node, index) => (
    <MarkdownBlock key={index} node={node} components={props.components} urlTransform={props.urlTransform} />
  ));
}
