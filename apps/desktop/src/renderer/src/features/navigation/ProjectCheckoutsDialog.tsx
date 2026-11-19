import { useId, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { canonicalizeNavigationPath, type SetProjectCheckoutGroupRequest } from "@pwragent/shared";
import { useModalDialog } from "../../lib/useModalDialog";

type Props = {
  projectPath: string;
  checkoutPaths?: string[];
  suggestions: string[];
  returnFocus: RefObject<HTMLElement | null>;
  pickCheckout: () => Promise<string | undefined>;
  copyPath: (path: string) => void;
  revealPath?: (path: string) => void;
  onSave: (request: SetProjectCheckoutGroupRequest) => Promise<void>;
  onClose: () => void;
};

export function ProjectCheckoutsDialog(props: Props) {
  const titleId = useId();
  const hintId = useId();
  const [paths, setPaths] = useState(props.checkoutPaths ?? [props.projectPath]);
  const [preferredPath, setPreferredPath] = useState(props.projectPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useModalDialog<HTMLElement>({
    onClose: () => { if (!busy) props.onClose(); },
    returnFocus: props.returnFocus,
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
  const suggestions = props.suggestions.filter((path) => !paths.includes(path));

  return createPortal(
    <div className="rename-thread-backdrop" role="presentation">
      <section ref={dialogRef} aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId}
        className="rename-thread-dialog project-checkouts-dialog" role="dialog">
        <h2 id={titleId}>Project Checkouts</h2>
        <p id={hintId}>Choose where new threads start. Existing threads keep their workspaces.</p>
        <fieldset className="project-checkouts-dialog__paths" disabled={busy}>
          <legend>Preferred checkout</legend>
          {paths.map((path) => (
            <div className="project-checkouts-dialog__row" key={path}>
              <label>
                <input type="radio" name={titleId} checked={path === preferredPath}
                  onChange={() => setPreferredPath(path)} />
                <span title={path}>{path}</span>
              </label>
              <button className="button button--secondary" type="button" aria-label={`Copy path ${path}`}
                onClick={() => props.copyPath(path)}>Copy</button>
              {props.revealPath ? (
                <button className="button button--secondary" type="button" aria-label={`Show checkout ${path}`}
                  onClick={() => props.revealPath?.(path)}>Show</button>
              ) : null}
              <button className="button button--secondary" type="button" aria-label={`Remove checkout ${path}`}
                disabled={paths.length === 1 || (!props.checkoutPaths && path === props.projectPath)}
                onClick={() => remove(path)}>Remove</button>
            </div>
          ))}
        </fieldset>
        {suggestions.length > 0 ? (
          <div className="project-checkouts-dialog__paths">
            <span>Same Git remote</span>
            {suggestions.map((path) => (
              <div className="project-checkouts-dialog__row" key={path}>
                <span title={path}>{path}</span>
                <button className="button button--secondary" type="button" aria-label={`Add checkout ${path}`}
                  disabled={busy} onClick={() => add(path)}>Add</button>
              </div>
            ))}
          </div>
        ) : null}
        <button className="button button--secondary" type="button" disabled={busy}
          onClick={() => void run(async () => {
            const path = await props.pickCheckout();
            if (path) add(path);
          })}>Choose Folder…</button>
        {error ? <p className="rename-thread-dialog__error" role="alert">{error}</p> : null}
        <div className="rename-thread-dialog__actions">
          <button className="button button--secondary" type="button" disabled={busy} onClick={props.onClose}>Cancel</button>
          <button className="button button--primary" type="button" disabled={busy}
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
