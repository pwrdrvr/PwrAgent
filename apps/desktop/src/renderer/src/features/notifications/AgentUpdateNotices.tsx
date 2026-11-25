import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "./AppNoticeToast";
import { AntigravityUpdateNotice } from "./AntigravityUpdateNotice";
import { GrokCliUpdateNotice } from "./GrokCliUpdateNotice";

export type AgentUpdateNoticeHandlers = {
  desktopApi?: DesktopApi;
  onGrokNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
  onAntigravityNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
  onOpenAntigravitySettings: () => void;
};

/** The ACP agents' update notice producers, mounted together by the app shell. */
export function AgentUpdateNotices(props: { handlers: AgentUpdateNoticeHandlers }) {
  const { handlers } = props;
  const { desktopApi } = handlers;
  return (
    <>
      <GrokCliUpdateNotice
        desktopApi={desktopApi}
        onNoticeChanged={handlers.onGrokNoticeChanged}
      />
      <AntigravityUpdateNotice
        desktopApi={desktopApi}
        onNoticeChanged={handlers.onAntigravityNoticeChanged}
        onOpenSettings={handlers.onOpenAntigravitySettings}
      />
    </>
  );
}
