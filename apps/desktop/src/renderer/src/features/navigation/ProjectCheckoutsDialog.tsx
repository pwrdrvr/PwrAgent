import { useId, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";
import { type SetProjectCheckoutGroupRequest } from "@pwragent/shared/contracts/navigation";
import { CloseIcon, CopyIcon, FolderIcon, FolderPlusIcon, PopoutIcon } from "../../icons";
import { useModalDialog } from "../../lib/useModalDialog";

type Props = {
  projectPath: string;
  checkoutPaths?: string[];
  /** The project's name in Directories. */
  projectLabel?: string;
  /** `host/owner/repo` shared by the grouped checkouts, when known. */
  repositoryKey?: string;
  suggestions: string[];
  returnFocus: RefObject<HTMLElement | null>;
  pickCheckout: () => Promise<string | undefined>;
  copyPath: (path: string) => void;
  /** "Show in Finder" and the like; required with `revealPath`. */
  revealLabel?: string;
  revealPath?: (path: string) => void;
  onSave: (request: SetProjectCheckoutGroupRequest) => Promise<void>;
  onClose: () => void;
};

/** A checkout's folder name, and the folder that holds it. */
function splitCheckoutPath(path: string): { name: string; parent: string } {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return { name: path, parent: "" };
  return { name: path.slice(slash + 1) || path, parent: path.slice(0, slash) || "/" };
}

function CheckoutRow(props: {
  path: string;
  isDefault?: boolean;
  suggested?: boolean;
  children: ReactNode;
}) {
  const { name, parent } = splitCheckoutPath(props.path);
  return (
    <li className="project-checkouts-dialog__row" data-default={props.isDefault ? "true" : undefined}
      data-suggested={props.suggested ? "true" : undefined}>
      <FolderIcon className="project-checkouts-dialog__glyph" size={16} aria-hidden="true" />
      <div className="project-checkouts-dialog__name">
        <span className="project-checkouts-dialog__title">
          <span className="project-checkouts-dialog__folder">{name}</span>
          {props.isDefault ? <span className="project-checkouts-dialog__badge">Default</span> : null}
        </span>
        <span className="project-checkouts-dialog__path tooltip-target" data-tooltip={props.path}>
          {parent}
        </span>
      </div>
      <div className="project-checkouts-dialog__actions">
        {props.children}
      </div>
    </li>
  );
}

function IconAction(props: {
  label: string;
  tooltip: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="project-checkouts-dialog__icon tooltip-target" type="button" aria-label={props.label}
      data-tooltip={props.tooltip} onClick={props.onClick}>
      {props.icon}
    </button>
  );
}

export function ProjectCheckoutsDialog(props: Props) {
  const titleId = useId();
  const hintId = useId();
  const suggestedId = useId();
  const initialPaths = props.checkoutPaths ?? [props.projectPath];
  const [paths, setPaths] = useState(initialPaths);
  const [preferredPath, setPreferredPath] = useState(props.projectPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useModalDialog<HTMLElement>({
    onClose: () => { if (!busy) props.onClose(); },
    returnFocus: props.returnFocus,
    // The first control is a row action; landing there would put a ring on
    // Make Default and let an early Enter change the group.
    initialFocus: "dialog",
  });

  const add = (path: string) => {
    const checkout = canonicalizeNavigationPath(path);
    setPaths((current) => current.includes(checkout) ? current : [...current, checkout]);
    setError(undefined);
  };
  const remove = (path: string) => {
    const remaining = paths.filter((candidate) => candidate !== path);
    setPaths(remaining);
    if (preferredPath === path) setPreferredPath(remaining[0]!);
    setError(undefined);
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  // An ungrouped project cannot drop the checkout it was opened from, and a
  // group keeps at least one checkout.
  const removable = (path: string) =>
    paths.length > 1 && (Boolean(props.checkoutPaths) || path !== props.projectPath);
  const changed = preferredPath !== props.projectPath
    || paths.length !== initialPaths.length
    || paths.some((path) => !initialPaths.includes(path));
  const suggestions = props.suggestions.filter((path) => !paths.includes(path));
  const identity = props.repositoryKey ?? props.projectLabel;

  return createPortal(
    <div className="rename-thread-backdrop" role="presentation">
      <section ref={dialogRef} aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId}
        aria-busy={busy || undefined} className="rename-thread-dialog project-checkouts-dialog" role="dialog"
        tabIndex={-1}>
        <header className="project-checkouts-dialog__header">
          <h2 id={titleId}>Project Checkouts</h2>
          {identity ? (
            <p className="project-checkouts-dialog__identity">{identity}</p>
          ) : null}
        </header>
        <p id={hintId} className="project-checkouts-dialog__hint">
          New threads start in the default checkout. Existing threads keep their workspaces.
        </p>
        <fieldset className="project-checkouts-dialog__body" disabled={busy}>
          <ul className="project-checkouts-dialog__list" aria-label="Checkouts">
            {paths.map((path) => {
              const isDefault = path === preferredPath;
              return (
                <CheckoutRow key={path} path={path} isDefault={isDefault}>
                  {isDefault ? null : (
                    <button className="button button--ghost project-checkouts-dialog__make-default" type="button"
                      aria-label={`Make Default: ${path}`} onClick={() => setPreferredPath(path)}>
                      Make Default
                    </button>
                  )}
                  <IconAction label={`Copy path ${path}`} tooltip="Copy Path"
                    icon={<CopyIcon size={14} aria-hidden="true" />} onClick={() => props.copyPath(path)} />
                  {props.revealPath && props.revealLabel ? (
                    <IconAction label={`${props.revealLabel}: ${path}`} tooltip={props.revealLabel}
                      icon={<PopoutIcon size={14} aria-hidden="true" />} onClick={() => props.revealPath?.(path)} />
                  ) : null}
                  {removable(path) ? (
                    <IconAction label={`Remove checkout ${path}`} tooltip="Remove from Project"
                      icon={<CloseIcon size={14} aria-hidden="true" />} onClick={() => remove(path)} />
                  ) : null}
                </CheckoutRow>
              );
            })}
          </ul>
          <button className="button button--ghost project-checkouts-dialog__add" type="button"
            onClick={() => void run(async () => {
              const path = await props.pickCheckout();
              if (path) add(path);
            })}>
            <FolderPlusIcon size={14} aria-hidden="true" />
            Add Checkout…
          </button>
          {suggestions.length > 0 ? (
            <section className="project-checkouts-dialog__suggested" aria-labelledby={suggestedId}>
              <h3 id={suggestedId}>
                Suggested
                <span>Same Git remote</span>
              </h3>
              <ul className="project-checkouts-dialog__list project-checkouts-dialog__list--suggested">
                {suggestions.map((path) => (
                  <CheckoutRow key={path} path={path} suggested>
                    <button className="button button--secondary project-checkouts-dialog__suggest-add" type="button"
                      aria-label={`Add checkout ${path}`} onClick={() => add(path)}>
                      Add
                    </button>
                  </CheckoutRow>
                ))}
              </ul>
            </section>
          ) : null}
        </fieldset>
        {error ? <p className="rename-thread-dialog__error" role="alert">{error}</p> : null}
        <div className="rename-thread-dialog__actions">
          <button className="button button--secondary" type="button" disabled={busy} onClick={props.onClose}>Cancel</button>
          <button className="button button--primary" type="button" disabled={busy || !changed}
            onClick={() => void run(async () => {
              await props.onSave({
                projectPath: props.projectPath, previousPaths: props.checkoutPaths ?? [],
                group: { paths, preferredPath },
              });
              props.onClose();
            })}>Save</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
