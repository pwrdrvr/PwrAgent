import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";

const FIT = { scale: 1, x: 0, y: 0 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Adapted from PwrSnap's editor/useZoomPan: explicit image dimensions,
 * cursor-anchored zoom, unmodified wheel pan and a 64px visible pan handle.
 * Keep ordinary wheel events uncancelled: cancelling them can suppress macOS
 * pinch synthesis. The modal locks document scrolling and contains overscroll. */
export function useLightboxGestures() {
  const viewport = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState(FIT);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ id: number; x: number; y: number } | null>(null);
  const fit = Math.min(1, size.width / natural.width, size.height / natural.height) || 0;
  const width = natural.width * fit;
  const height = natural.height * fit;
  const bound = useCallback((candidate: typeof FIT) => {
    const limitX = Math.max(0, (size.width + width * candidate.scale) / 2 - Math.min(64, size.width, width * candidate.scale));
    const limitY = Math.max(0, (size.height + height * candidate.scale) / 2 - Math.min(64, size.height, height * candidate.scale));
    return { ...candidate, x: clamp(candidate.x, -limitX, limitX), y: clamp(candidate.y, -limitY, limitY) };
  }, [size, width, height]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { setView((previous) => bound(previous)); }, [bound]);

  const zoom = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clientX === undefined ? 0 : clientX - rect.left - size.width / 2;
    const y = clientY === undefined ? 0 : clientY - rect.top - size.height / 2;
    setView((previous) => {
      const scale = clamp(previous.scale * factor, 0.1, 8);
      const ratio = scale / previous.scale;
      return bound({ scale, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio });
    });
  }, [size, bound]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let gestureScale: number | undefined;
    const wheel = (event: WheelEvent) => {
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        // A native gesture stream owns zoom until gestureend; do not apply
        // an accompanying synthetic ctrl+wheel stream a second time.
        if (gestureScale === undefined) zoom(1.0025 ** (-event.deltaY * unit), event.clientX, event.clientY);
      } else {
        setView((previous) => bound({ ...previous, x: previous.x - event.deltaX * unit, y: previous.y - event.deltaY * unit }));
      }
    };
    const gesture = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const value = event as Event & { scale?: number; clientX?: number; clientY?: number };
      if (event.type === "gesturestart") gestureScale = 1;
      if (event.type === "gesturechange" && Number.isFinite(value.scale) && value.scale! > 0) {
        zoom(value.scale! / (gestureScale ?? 1), value.clientX, value.clientY);
        gestureScale = value.scale;
      }
      if (event.type === "gestureend") gestureScale = undefined;
    };
    element.addEventListener("wheel", wheel, { passive: false });
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) element.addEventListener(type, gesture, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) element.removeEventListener(type, gesture);
    };
  }, [zoom, bound, size.height]);

  useLayoutEffect(() => {
    const cancel = () => {
      const id = pan.current?.id;
      pan.current = null;
      setPanning(false);
      if (id !== undefined && viewport.current?.hasPointerCapture(id)) viewport.current.releasePointerCapture(id);
    };
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, []);

  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (pan.current?.id !== event.pointerId) return;
    pan.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    viewport,
    view,
    panning,
    zoom,
    reset: () => { setView(FIT); },
    onLoad: (image: HTMLImageElement) => setNatural({ width: image.naturalWidth, height: image.naturalHeight }),
    imageStyle: width && height ? { width: width * view.scale, height: height * view.scale, transform: `translate(${view.x}px, ${view.y}px)` } : undefined,
    pointerHandlers: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        if ((event.button !== 0 && event.button !== 1) || pan.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        setPanning(true);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        const start = pan.current;
        if (!start || start.id !== event.pointerId) return;
        if (!event.buttons) { endPan(event); return; }
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        pan.current = { id: start.id, x: event.clientX, y: event.clientY };
        setView((previous) => bound({ ...previous, x: previous.x + dx, y: previous.y + dy }));
      },
      onPointerUp: endPan,
      onPointerCancel: endPan,
      onLostPointerCapture: endPan,
    },
  };
}
