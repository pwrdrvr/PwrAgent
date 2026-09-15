import { useEffect, useRef, useState } from "react";
import { copyImage } from "../../lib/copy-image";

export function ImageCopyButton({ src }: { src: string }) {
  return <ClipboardActionButton key={src} label="Copy image" copy={() => copyImage(src)} />;
}

export function ClipboardActionButton({ label, copy }: { label: string; copy: () => Promise<void> }) {
  const [status, setStatus] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.clearTimeout(timer.current); };
  }, []);
  return <>
    <button type="button" className="image-viewer__button" disabled={status === "pending"}
      onClick={(event) => {
        event.stopPropagation();
        window.clearTimeout(timer.current);
        setStatus("pending");
        void copy().then(() => {
          if (!mounted.current) return;
          setStatus("copied");
          timer.current = window.setTimeout(() => setStatus("idle"), 1400);
        }).catch(() => { if (mounted.current) setStatus("failed"); });
      }}>
      {status === "copied" ? "Copied" : label}
    </button>
    <span className="image-viewer__status" role={status === "failed" ? "alert" : "status"}>
      {status === "failed" ? `${label} failed. Try again or use the context menu.` : status === "copied" ? `${label} succeeded` : ""}
    </span>
  </>;
}
