import { useMemo, useState, type ReactElement } from "react";
import { SegmentedControl } from "../../settings/SettingsLayout";
import { ResourcesScreen } from "../ResourcesScreen";
import { createPreviewResourceCheckoutsSource, type PreviewViewerRole } from "./resource-checkouts-preview";

/**
 * The development preview of the Resources screen, mounted at
 * `#resources-preview` only in a development build (see `main.tsx`). It runs
 * the real screen against invented fixture data and a simulated authority;
 * the screen's own banner marks every view of it as preview data.
 */
export function ResourcesPreviewWindow(): ReactElement {
  const source = useMemo(() => createPreviewResourceCheckoutsSource(), []);
  const [role, setRole] = useState<PreviewViewerRole>("operator");
  return (
    <div className="resources-preview-window">
      <ResourcesScreen
        previewControls={(
          <SegmentedControl
            label="View as"
            options={[
              { label: "Operator", value: "operator" },
              { label: "Member", value: "member" },
              { label: "Viewer", value: "viewer" },
            ]}
            value={role}
            onChange={(next) => {
              setRole(next);
              source.setRole(next);
            }}
          />
        )}
        source={source}
        onOpenThread={() => undefined}
      />
    </div>
  );
}
