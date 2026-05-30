import type { MessagingChannelKind } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";

type ThreadPlaceholderHeaderProps = {
  desktopApi?: DesktopApi;
  title: string;
  onOpenMessagingActivity?: (platform?: MessagingChannelKind) => void;
};

export function ThreadPlaceholderHeader(props: ThreadPlaceholderHeaderProps) {
  return (
    <header className="thread-header thread-header--placeholder">
      <div className="thread-header__main">
        <div className="thread-header__eyebrow-row">
          <h2 className="thread-header__compact-title">{props.title}</h2>
        </div>
      </div>
      <MessagingStatusBar
        desktopApi={props.desktopApi}
        onOpenActivity={props.onOpenMessagingActivity}
      />
    </header>
  );
}
