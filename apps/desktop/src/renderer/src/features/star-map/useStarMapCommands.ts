import { useEffect, useRef } from "react";
import type {
  SetStarMapViewToolArgs,
  StarMapCommand,
  StarMapCommandResponse,
  StarMapCommandResult,
  StarMapFlightTarget,
  StarMapThreadOpenMode,
  StarMapThreadRef,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

export type StarMapFlightResponse = StarMapCommandResponse<"fly_to">;
export type StarMapHighlightResponse = StarMapCommandResponse<"highlight">;
export type StarMapSetViewResponse = StarMapCommandResponse<"set_view">;

export type StarMapCommandHandlers = {
  onFlyTo: (
    target: StarMapFlightTarget,
    open?: StarMapThreadOpenMode,
  ) => Promise<StarMapFlightResponse>;
  /** An empty list clears the highlight. */
  onHighlight: (
    threads: StarMapThreadRef[],
  ) => Promise<StarMapHighlightResponse>;
  onSetView: (changes: SetStarMapViewToolArgs) => StarMapSetViewResponse;
};

/** Run one command through its handler, and label the answer with it. */
async function answerFor(
  command: StarMapCommand,
  handlers: StarMapCommandHandlers,
): Promise<StarMapCommandResult> {
  const { requestId } = command;
  switch (command.kind) {
    case "fly_to":
      return {
        requestId,
        kind: command.kind,
        response: await handlers.onFlyTo(command.target, command.open),
      };
    case "highlight":
      return {
        requestId,
        kind: command.kind,
        response: await handlers.onHighlight(command.threads),
      };
    case "set_view":
      return {
        requestId,
        kind: command.kind,
        response: handlers.onSetView(command.changes),
      };
  }
}

/**
 * Answer the commands an Agent tool sends this map.
 *
 * Every command gets exactly one answer, including a thrown handler: the
 * main process holds the Agent's tool call open until the map replies, so a
 * command that goes unanswered costs a turn the full timeout.
 */
export function useStarMapCommands(
  params: StarMapCommandHandlers & { desktopApi?: DesktopApi },
): void {
  // Assigned from an effect: the handlers close over the layout, and a
  // render React abandons must not be the one a command lands on.
  const handlersRef = useRef<StarMapCommandHandlers>(params);
  useEffect(() => {
    handlersRef.current = params;
  });
  const subscribe = params.desktopApi?.onStarMapCommand;
  const answer = params.desktopApi?.resolveStarMapCommand;
  useEffect(() => {
    if (!subscribe || !answer) return;
    return subscribe((command) => {
      void (async () => {
        let result: StarMapCommandResult;
        try {
          result = await answerFor(command, handlersRef.current);
        } catch (error) {
          // A failure is a valid answer to any command, so the label the
          // command came with still types it.
          result = {
            requestId: command.requestId,
            kind: command.kind,
            response: {
              ok: false,
              error: {
                code: "internal_error",
                message: error instanceof Error ? error.message : String(error),
              },
            },
          } as StarMapCommandResult;
        }
        await answer(result).catch(() => undefined);
      })();
    });
  }, [answer, subscribe]);
}
