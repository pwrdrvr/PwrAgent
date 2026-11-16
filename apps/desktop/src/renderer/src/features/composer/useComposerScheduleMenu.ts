import { useCallback, useEffect, useRef, useState } from "react";
import { useMenuNavigation } from "../../lib/useMenuNavigation";

export function useComposerScheduleMenu() {
  const [scheduleMenuOpen, setScheduleMenuOpen] = useState(false);
  // The send split (pill and menu), the menu itself, and its caret. The
  // menu takes the ARIA menu keyboard from useMenuNavigation, which leaves
  // the pointer to us: a press outside the split closes it.
  const scheduleMenuRef = useRef<HTMLDivElement>(null);
  const scheduleMenuListRef = useRef<HTMLDivElement>(null);
  const scheduleMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeScheduleMenu = useCallback(() => setScheduleMenuOpen(false), []);
  useMenuNavigation({
    open: scheduleMenuOpen,
    menuRef: scheduleMenuListRef,
    triggerRef: scheduleMenuTriggerRef,
    onClose: closeScheduleMenu,
  });
  useEffect(() => {
    if (!scheduleMenuOpen) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (!scheduleMenuRef.current?.contains(event.target as Node)) {
        setScheduleMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [scheduleMenuOpen]);

  return {
    scheduleMenuOpen,
    setScheduleMenuOpen,
    scheduleMenuRef,
    scheduleMenuListRef,
    scheduleMenuTriggerRef,
  };
}
