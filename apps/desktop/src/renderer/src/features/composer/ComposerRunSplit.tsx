import { useId, useRef, useState } from "react";
import { PendingSpinner } from "../../components/PendingSpinner";
import { ChevronDownIcon, FileCodeIcon, PencilIcon, PlayIcon } from "../../icons";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { useComposerPopoverClamp } from "./useComposerPopoverClamp";

export type ComposerRunSplitCommand = {
  id: string;
  name: string;
  /** This command is starting now. */
  starting?: boolean;
};

export type ComposerRunSplitEnvironment = {
  id: string;
  name: string;
  /** Listed but not selectable, with the reason. */
  unavailableReason?: string;
};

export type ComposerRunSplitProps = {
  /** The selected environment's id, or "" for none. */
  environmentId: string;
  environments: readonly ComposerRunSplitEnvironment[];
  /** The selected environment's commands; empty without one. */
  commands: readonly ComposerRunSplitCommand[];
  selectedCommandId?: string;
  /** The environment is setting up or switching. */
  busy?: boolean;
  environmentDisabled?: boolean;
  runDisabled?: boolean;
  onSelectEnvironment: (environmentId: string) => void;
  onSelectCommand: (commandId: string) => void;
  /** Runs `command`, or the selected one when left out. */
  onRun: (command?: ComposerRunSplitCommand) => void;
  editAction?: { label: string; onSelect: () => void };
};

/**
 * The environment, its command and ▶ as one split button: the left half runs
 * the selected command and is labelled with it, the chevron opens one menu
 * of the commands (each with its own ▶), the environments, and Edit
 * environments. Without an environment only the menu half shows, as an icon.
 */
export function ComposerRunSplit(props: ComposerRunSplitProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useMenuNavigation({
    open,
    menuRef,
    triggerRef,
    onClose: () => setOpen(false),
    includeAriaDisabled: true,
  });
  const menuStyle = useComposerPopoverClamp(open, menuRef);
  const environment = props.environments.find((candidate) => candidate.id === props.environmentId);
  const selectedCommand = props.commands.find((command) => command.id === props.selectedCommandId);
  const hasEnvironment = Boolean(environment);
  const environmentName = environment?.name ?? "No environment";
  const runLabel = selectedCommand ? `Run ${selectedCommand.name}` : "Run command";
  const close = () => setOpen(false);

  return (
    <div
      className={[
        "composer-run",
        hasEnvironment ? "" : "composer-run--bare",
        open ? "is-open" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className="composer-run__pill">
        {hasEnvironment ? (
          <button
            aria-busy={selectedCommand?.starting || undefined}
            aria-label={runLabel}
            className="composer-run__run tooltip-target"
            data-tooltip={`${runLabel} · ${environmentName}`}
            disabled={props.runDisabled || props.busy || !selectedCommand || selectedCommand.starting}
            type="button"
            onClick={() => props.onRun()}
          >
            {selectedCommand?.starting ? (
              <PendingSpinner
                pairing="standalone"
                standaloneReason="The Run button swaps its play glyph for a bare ring; its label still names the command."
              />
            ) : (
              <PlayIcon size={11} aria-hidden="true" />
            )}
            <span className="composer-run__label">{selectedCommand?.name ?? "No commands"}</span>
          </button>
        ) : null}
        <button
          aria-busy={props.busy || undefined}
          aria-controls={open ? menuId : undefined}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`Environment: ${environmentName}`}
          className="composer-run__menu-button tooltip-target"
          data-tooltip={open ? undefined : `Environment: ${environmentName}`}
          // Its commands belong to the environment being replaced.
          disabled={props.busy}
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          {props.busy ? (
            <PendingSpinner
              pairing="standalone"
              standaloneReason="The environment button swaps its icon for a bare ring while it switches; its only text is the aria-label."
            />
          ) : hasEnvironment ? (
            <ChevronDownIcon size={12} aria-hidden="true" />
          ) : (
            <FileCodeIcon size={14} aria-hidden="true" />
          )}
        </button>
      </div>
      {open ? (
        <div
          aria-label="Environment and commands"
          className="composer-dropdown__menu composer-run__menu"
          id={menuId}
          ref={menuRef}
          role="menu"
          style={menuStyle}
          tabIndex={-1}
        >
          {props.commands.length > 0 ? (
            <>
              <div aria-label="Command" role="group">
                <div aria-hidden="true" className="composer-thread-options__section">Command</div>
                {props.commands.map((command) => {
                  const selected = command.id === props.selectedCommandId;
                  return (
                    <div className="composer-thread-options__command" key={command.id} role="none">
                      <button
                        aria-checked={selected}
                        className="composer-dropdown__option"
                        disabled={props.runDisabled || props.busy}
                        role="menuitemradio"
                        type="button"
                        onClick={() => {
                          close();
                          if (!selected) props.onSelectCommand(command.id);
                        }}
                      >
                        <span aria-hidden="true" className="composer-dropdown__check">
                          {selected ? "✓" : ""}
                        </span>
                        {command.name}
                      </button>
                      <button
                        aria-label={`Run ${command.name}`}
                        className="composer-thread-options__command-run"
                        disabled={props.runDisabled || props.busy || command.starting}
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          close();
                          props.onRun(command);
                        }}
                      >
                        {command.starting ? (
                          <PendingSpinner
                            pairing="standalone"
                            standaloneReason="A command's Run button swaps its play glyph for a bare ring; its only text is the aria-label."
                          />
                        ) : (
                          <PlayIcon size={13} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="composer-dropdown__separator" role="separator" />
            </>
          ) : null}
          <div aria-label="Environment" role="group">
            <div aria-hidden="true" className="composer-thread-options__section">Environment</div>
            {[{ id: "", name: "No environment" } as ComposerRunSplitEnvironment, ...props.environments].map((option) => {
              const selected = option.id === props.environmentId;
              const unavailable = Boolean(option.unavailableReason);
              return (
                <button
                  aria-checked={selected}
                  aria-description={option.unavailableReason}
                  aria-disabled={unavailable || undefined}
                  className="composer-dropdown__option"
                  disabled={props.environmentDisabled}
                  key={option.id || "none"}
                  role="menuitemradio"
                  type="button"
                  onClick={() => {
                    if (unavailable) return;
                    close();
                    if (!selected) props.onSelectEnvironment(option.id);
                  }}
                >
                  <span aria-hidden="true" className="composer-dropdown__check">
                    {selected ? "✓" : ""}
                  </span>
                  <span className="composer-dropdown__option-body">
                    <span className="composer-dropdown__option-label">{option.name}</span>
                    {option.unavailableReason ? (
                      <span aria-hidden="true" className="composer-dropdown__option-description">
                        {option.unavailableReason}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
          {props.editAction ? (
            <>
              <div className="composer-dropdown__separator" role="separator" />
              <button
                className="composer-dropdown__option"
                role="menuitem"
                type="button"
                onClick={() => {
                  close();
                  props.editAction?.onSelect();
                }}
              >
                <span aria-hidden="true" className="composer-dropdown__check">
                  <PencilIcon size={12} aria-hidden="true" />
                </span>
                {props.editAction.label}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
