import { GrokIcon, OpenAIIcon, PwrAgentIcon, TerminalIcon } from "../../../icons";

export type SetupMarkId = "pwragent" | "codex" | "grok" | "cli";

/**
 * An app or provider mark for the guided setup diagrams and provider cards.
 * PwrAgent's app icon is its own tile. A vendor mark is the vendor's
 * official file (see `assets/openai/` and `assets/grok/`) drawn on a neutral
 * tile beside it. A provider without an approved mark gets a generic
 * terminal glyph, never a lookalike of its logo.
 */
export function SetupMark(props: { mark: SetupMarkId; className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`guided-setup__mark guided-setup__mark--${props.mark} ${props.className}`}
    >
      {props.mark === "pwragent" ? (
        <PwrAgentIcon />
      ) : props.mark === "codex" ? (
        <OpenAIIcon />
      ) : props.mark === "grok" ? (
        <GrokIcon />
      ) : (
        <TerminalIcon />
      )}
    </span>
  );
}
