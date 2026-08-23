import { useEffect } from "react";
import { buildStarMapDiagnosticsInfo } from "../../../../shared/local-diagnostics-info";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import type { IntakeDialogTarget } from "./IntakeDialog";

export function StarMapDiagnosticsListener(props: {
  desktopApi?: DesktopApi;
  intakeTarget?: IntakeDialogTarget;
}) {
  useEffect(() => {
    const desktopApi = props.desktopApi;
    const readAppMetadata = desktopApi?.readAppMetadata;
    if (
      !desktopApi?.onCopyLocalDiagnosticsInfoRequested
      || !readAppMetadata
    ) {
      return;
    }
    return desktopApi.onCopyLocalDiagnosticsInfoRequested(() => {
      void readAppMetadata().then((metadata) =>
        copyText(
          buildStarMapDiagnosticsInfo(
            { intakeTarget: props.intakeTarget },
            metadata,
          ),
          desktopApi,
        ),
      );
    });
  }, [props.desktopApi, props.intakeTarget]);

  return null;
}
