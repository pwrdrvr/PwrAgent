import { useEffect, useRef } from "react";
import type {
  PwrAgentStarMapResponse,
  StarMapFlightTarget,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

export type StarMapFlightResponse = PwrAgentStarMapResponse<"fly_star_map_to">;

/**
 * Answer the commands an Agent tool sends this map.
 *
 * Every command gets exactly one answer, including a thrown handler: the
 * main process holds the Agent's tool call open until the map replies, so a
 * command that goes unanswered costs a turn the full timeout.
 */
export function useStarMapCommands(params: {
  desktopApi?: DesktopApi;
  onFlyTo: (target: StarMapFlightTarget) => Promise<StarMapFlightResponse>;
}): void {
  // Assigned from an effect: the handler closes over the layout, and a
  // render React abandons must not be the one a command lands on.
  const flyToRef = useRef(params.onFlyTo);
  useEffect(() => {
    flyToRef.current = params.onFlyTo;
  });
  const subscribe = params.desktopApi?.onStarMapCommand;
  const answer = params.desktopApi?.resolveStarMapCommand;
  useEffect(() => {
    if (!subscribe || !answer) return;
    return subscribe((command) => {
      void (async () => {
        let response: StarMapFlightResponse;
        try {
          response = command.kind === "fly_to"
            ? await flyToRef.current(command.target)
            : {
                ok: false,
                error: {
                  code: "unsupported_operation",
                  message: "The Star Map does not know that command.",
                },
              };
        } catch (error) {
          response = {
            ok: false,
            error: {
              code: "internal_error",
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
        await answer({ requestId: command.requestId, response }).catch(
          () => undefined,
        );
      })();
    });
  }, [answer, subscribe]);
}
