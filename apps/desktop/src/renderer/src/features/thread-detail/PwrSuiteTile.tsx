import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  PWRSUITE_PRODUCT_URLS,
  type PwrSuiteAppId,
} from "../../../../shared/pwrsuite-installer";
import { CloseIcon, InfoIcon, PopoutIcon } from "../../icons";
import { formatByteCount } from "../../lib/format-bytes";
import { openExternalUrl } from "../../lib/open-external-url";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { portalViewportTop, useViewportTooltip } from "../../lib/useViewportTooltip";
import { downloadMeter } from "../update/update-progress";
import type { PwrSuiteInstaller } from "./usePwrSuiteInstaller";

export type PwrSuiteTileLineTone = "pitch" | "state" | "error";

/**
 * One launchpad tile for a sister app: icon, name, one line, one action.
 *
 * The tiles are ads for the other PwrSuite apps, so they stay one line tall.
 * Everything the old cards said in a paragraph now sits behind the Info
 * button, and the website is one click away beside it. `.mcp-connection`
 * stays the root class because the launchpad's layout, its bounds test, and
 * the E2E specs all find the tiles by it.
 */
export function PwrSuiteTile(props: {
  app: PwrSuiteAppId;
  name: string;
  icon: string;
  ariaLabel: string;
  line: ReactNode;
  lineTone?: PwrSuiteTileLineTone;
  /** The paragraph behind the Info button. Omitted on a remote tile. */
  about?: { title: string; body: string };
  /** A remote thread's owner, shown as a tag beside the name. */
  tag?: string;
  connected?: boolean;
  action: ReactNode;
}) {
  const tone = props.lineTone ?? "pitch";
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const siteUrl = PWRSUITE_PRODUCT_URLS[props.app];
  const siteLabel = `Open ${new URL(siteUrl).host}`;
  const lineRef = useRef<HTMLParagraphElement>(null);

  const showLineIfClipped = (): void => {
    const line = lineRef.current;
    if (line && line.scrollWidth > line.clientWidth) {
      tooltip.show(line, line.textContent ?? "");
    }
  };

  return (
    <aside
      className={
        "mcp-connection pwrsuite-tile"
        + (props.connected ? " pwrsuite-tile--connected" : "")
      }
      aria-label={props.ariaLabel}
    >
      <img
        alt=""
        aria-hidden="true"
        className="mcp-connection__icon"
        src={props.icon}
      />
      <div className="mcp-connection__copy">
        <div className="pwrsuite-tile__head">
          <h2>{props.name}</h2>
          {props.tag ? <span className="pwrsuite-tile__tag">{props.tag}</span> : null}
          {props.about ? (
            <>
              <PwrSuiteAboutButton
                app={props.app}
                name={props.name}
                about={props.about}
                siteUrl={siteUrl}
              />
              <button
                aria-label={siteLabel}
                className="pwrsuite-tile__icon-button"
                type="button"
                onBlur={tooltip.hide}
                onClick={() => openExternalUrl(siteUrl)}
                onFocus={(event) => tooltip.show(event.currentTarget, siteLabel)}
                onMouseEnter={(event) => tooltip.show(event.currentTarget, siteLabel)}
                onMouseLeave={tooltip.hide}
              >
                <PopoutIcon size={13} />
              </button>
            </>
          ) : null}
        </div>
        <p
          ref={lineRef}
          className={`pwrsuite-tile__line pwrsuite-tile__line--${tone}`}
          role={tone === "error" ? "status" : undefined}
          onMouseEnter={showLineIfClipped}
          onMouseLeave={tooltip.hide}
        >
          {props.line}
        </p>
      </div>
      <div className="mcp-connection__action">{props.action}</div>
      {tooltip.tooltipNode}
    </aside>
  );
}

const ABOUT_WIDTH = 340;
const ABOUT_GAP = 8;
const VIEWPORT_MARGIN = 16;

function PwrSuiteAboutButton(props: {
  app: PwrSuiteAppId;
  name: string;
  about: { title: string; body: string };
  siteUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ top: number; left: number }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const close = useCallback(() => {
    setOpen(false);
    setPlacement(undefined);
  }, []);

  useDismissableLayer({ open, onDismiss: close, surfaceRef, triggerRef });

  // Measured before paint, so the card never shows at the origin.
  useLayoutEffect(() => {
    if (!open || placement) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const surface = surfaceRef.current;
    if (!trigger || !surface) return;
    const width = surface.offsetWidth || ABOUT_WIDTH;
    const height = surface.offsetHeight;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, trigger.left - 16),
      window.innerWidth - width - VIEWPORT_MARGIN,
    );
    const below = trigger.bottom + ABOUT_GAP;
    const above = trigger.top - ABOUT_GAP - height;
    const top =
      below + height <= window.innerHeight - VIEWPORT_MARGIN
      || above < portalViewportTop()
        ? below
        : above;
    setPlacement({ top, left: Math.max(VIEWPORT_MARGIN, left) });
  }, [open, placement]);

  // A click anywhere else, or the list scrolling the trigger away, closes it.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (
        surfaceRef.current?.contains(target)
        || triggerRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };
    const handleScroll = (event: Event): void => {
      if (surfaceRef.current?.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [close, open]);

  const host = new URL(props.siteUrl).host;
  return (
    <>
      <button
        ref={triggerRef}
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`About ${props.name}`}
        className={"pwrsuite-tile__icon-button" + (open ? " is-open" : "")}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <InfoIcon size={13} />
      </button>
      {open
        ? createPortal(
            <div
              ref={surfaceRef}
              aria-label={`About ${props.name}`}
              className="pwrsuite-about"
              id={popoverId}
              role="dialog"
              style={
                placement
                  ? { top: placement.top, left: placement.left }
                  : { top: 0, left: 0, visibility: "hidden" }
              }
            >
              <p className="pwrsuite-about__eyebrow">PwrSuite · open source</p>
              <h3 className="pwrsuite-about__title">{props.about.title}</h3>
              <p className="pwrsuite-about__body">{props.about.body}</p>
              <p className="pwrsuite-about__note">
                Each thread opts in with its own switch. Codex’s and other
                agents’ own MCP connections are separate.
              </p>
              <div className="pwrsuite-about__foot">
                <span>{props.name}</span>
                <button
                  className="pwrsuite-about__link"
                  type="button"
                  onClick={() => {
                    openExternalUrl(props.siteUrl);
                    close();
                  }}
                >
                  {host}
                  <PopoutIcon size={11} />
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * The tile's line while an installer download is in flight or finished, or
 * `undefined` when the tile should show its pitch.
 */
export function pwrSuiteInstallLine(
  installer: PwrSuiteInstaller,
  name: string,
): { text: string; tone: PwrSuiteTileLineTone } | undefined {
  if (installer.actionError) {
    return { text: installer.actionError, tone: "error" };
  }
  const state = installer.state;
  switch (state?.phase) {
    case "downloading":
      return {
        text: state.offer ? `Downloading ${name} ${state.offer.version}` : `Downloading ${name}`,
        tone: "state",
      };
    case "verifying":
      return { text: "Checking the download…", tone: "state" };
    case "ready":
      return { text: "Installer in Downloads", tone: "state" };
    case "failed":
      return { text: state.error ?? "Download failed", tone: "error" };
    default:
      return undefined;
  }
}

/**
 * Get the app: download the installer for this machine, follow it, then open
 * it. Where there is no installer to fetch (Linux, or no installer API in
 * this window) the button goes to the product page instead.
 */
export function PwrSuiteInstallAction(props: {
  app: PwrSuiteAppId;
  name: string;
  installer: PwrSuiteInstaller;
}) {
  const { installer } = props;
  const state = installer.state;
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const revealLabel = state?.platform === "windows" ? "Show in Explorer" : "Show in Finder";

  if (installer.available && !state) {
    return <span className="pwrsuite-tile__state">Checking…</span>;
  }

  if (!state?.platform) {
    return (
      <button
        className="button button--secondary"
        type="button"
        onClick={() => openExternalUrl(PWRSUITE_PRODUCT_URLS[props.app])}
      >
        {`Get ${props.name}`}
        <PopoutIcon size={12} />
      </button>
    );
  }

  if (state.phase === "downloading" || state.phase === "verifying") {
    const total = state.totalBytes ?? state.offer?.sizeBytes;
    const received = state.receivedBytes ?? 0;
    const verifying = state.phase === "verifying";
    const percent =
      !verifying && total && total > 0
        ? Math.min(100, (received / total) * 100)
        : undefined;
    const meter = verifying
      ? undefined
      : downloadMeter({
          transferred: received,
          total,
          bytesPerSecond: state.bytesPerSecond,
        });
    return (
      <div className="pwrsuite-meter">
        <span
          aria-label={`Downloading ${props.name}`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
          className={
            "pwrsuite-meter__track"
            + (percent === undefined ? " pwrsuite-meter__track--unknown" : "")
          }
          role="progressbar"
        >
          <i style={percent === undefined ? undefined : { width: `${percent}%` }} />
        </span>
        {verifying ? null : (
          <button
            aria-label={`Cancel ${props.name} download`}
            className="pwrsuite-tile__icon-button pwrsuite-meter__cancel"
            type="button"
            onClick={installer.cancel}
          >
            <CloseIcon size={12} />
          </button>
        )}
        <p className="pwrsuite-meter__line">{meter ?? " "}</p>
      </div>
    );
  }

  if (state.phase === "ready") {
    return (
      <>
        <button className="button button--secondary" type="button" onClick={installer.reveal}>
          {revealLabel}
        </button>
        <button className="button button--primary" type="button" onClick={installer.open}>
          {state.platform === "windows" ? "Run installer" : "Open installer"}
        </button>
      </>
    );
  }

  if (state.phase === "failed") {
    return (
      <button className="button button--primary" type="button" onClick={installer.start}>
        Try again
      </button>
    );
  }

  const size = state.offer ? formatByteCount(state.offer.sizeBytes) : undefined;
  // Two tiles side by side have no room for the size, so the stylesheet
  // shows it only once they stack. The tooltip always carries it.
  const detail = state.offer
    ? `${props.name} ${state.offer.version} · ${size}`
    : undefined;
  return (
    <>
      <button
        className="button button--primary"
        type="button"
        onBlur={tooltip.hide}
        onClick={installer.start}
        onFocus={(event) => {
          if (detail) tooltip.show(event.currentTarget, detail);
        }}
        onMouseEnter={(event) => {
          if (detail) tooltip.show(event.currentTarget, detail);
        }}
        onMouseLeave={tooltip.hide}
      >
        {state.platform === "windows" ? "Download for Windows" : "Download for Mac"}
        {size ? (
          <>
            {" "}
            <span className="pwrsuite-tile__size">{size}</span>
          </>
        ) : null}
      </button>
      {tooltip.tooltipNode}
    </>
  );
}
