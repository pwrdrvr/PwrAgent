import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CopyIcon } from "../../icons";
import { copyText, copyTextWithHtml } from "../../lib/copy-text";
import { copyImage } from "../../lib/copy-image";
import { MathClipboardApiContext } from "../../lib/math-clipboard-context";
import { useMenuNavigation } from "../../lib/useMenuNavigation";

type CopyFormat = "png" | "latex" | "html";

export function MathFormula({ children, node }: {
  children?: ReactNode;
  node?: { properties?: Record<string, unknown> };
}) {
  const latex = typeof node?.properties?.dataLatex === "string" ? node.properties.dataLatex : "";
  const display = node?.properties?.dataDisplay === true;
  return <MathFormulaContent key={`${display}:${latex}`} latex={latex} display={display}>{children}</MathFormulaContent>;
}

function MathFormulaContent({ latex, display, children }: {
  latex: string;
  display: boolean;
  children?: ReactNode;
}) {
  const api = useContext(MathClipboardApiContext);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const [status, setStatus] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useMenuNavigation({ open: Boolean(position), menuRef: menu, triggerRef: trigger, onClose: () => setPosition(undefined) });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.clearTimeout(timer.current); };
  }, []);

  useEffect(() => {
    if (!position) return;
    const dismiss = (event: PointerEvent): void => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) {
        setPosition(undefined);
      }
    };
    const close = (): void => setPosition(undefined);
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [position]);

  const copy = async (format: CopyFormat): Promise<void> => {
    setPosition(undefined);
    window.clearTimeout(timer.current);
    setStatus("pending");
    try {
      if (format === "latex") {
        await copyText(latex, api);
      } else {
        const formula = root.current?.querySelector<HTMLElement>(".katex");
        if (!formula) throw new Error("Formula is unavailable");
        const exporter = await import("../../lib/math-clipboard-export");
        if (format === "png") {
          await copyImage(await exporter.formulaToPng(formula));
        } else {
          await copyTextWithHtml(latex, await exporter.formulaToHtml(formula), api);
        }
      }
      if (!mounted.current) return;
      setStatus("copied");
      timer.current = window.setTimeout(() => setStatus("idle"), 1400);
    } catch (error) {
      console.error("Failed to copy formula", error);
      if (mounted.current) setStatus("failed");
    }
  };

  return <span ref={root} className={`math-formula${display ? " math-formula--display" : ""}`}>
    {children}
    <button ref={trigger} type="button" className="math-formula__copy"
      aria-label="Copy formula" title="Copy formula" aria-haspopup="menu" aria-expanded={Boolean(position)}
      data-status={status} aria-disabled={status === "pending"} aria-busy={status === "pending"}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (status === "pending") return;
        if (position) { setPosition(undefined); return; }
        const rect = event.currentTarget.getBoundingClientRect();
        setPosition({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 208)),
          top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 112)),
        });
      }}>
      {status === "copied" ? <CheckIcon size={12} aria-hidden="true" /> : <CopyIcon size={12} aria-hidden="true" />}
    </button>
    {status === "failed" || status === "copied" ? createPortal(
      <span className="math-formula__status" role={status === "failed" ? "alert" : "status"}>
        {status === "failed" ? "Could not copy formula" : "Formula copied"}
      </span>, document.body,
    ) : null}
    {position ? createPortal(<div ref={menu} className="thread-context-menu math-formula__menu"
      role="menu" aria-label="Copy formula" style={position} onClick={(event) => event.stopPropagation()}>
      <button type="button" role="menuitem" onClick={() => { void copy("png"); }}>Copy transparent PNG</button>
      <button type="button" role="menuitem" onClick={() => { void copy("latex"); }}>Copy LaTeX</button>
      <button type="button" role="menuitem" onClick={() => { void copy("html"); }}>Copy formatted HTML</button>
    </div>, document.body) : null}
  </span>;
}
