import { useEffect, useState } from "react";
import type { AgentPreset } from "@pwragent/shared/contracts/agent-presets";
import type { McpConnectionStatus } from "@pwragent/shared/contracts/mcp-connections";
import type { DesktopApi } from "../../lib/desktop-api";

export function useAgentPresetCatalog(desktopApi?: DesktopApi) {
  const manage = desktopApi?.manageAgentPresets;
  const readConnections = desktopApi?.listMcpConnections;
  const [presets, setPresets] = useState<AgentPreset[]>();
  const [connections, setConnections] = useState<McpConnectionStatus[]>();
  const [presetError, setPresetError] = useState<string>();
  const [connectionError, setConnectionError] = useState(false);

  useEffect(() => {
    if (!manage) return;
    let current = true;
    void manage({ action: "list" }).then((items) => {
      if (!current) return;
      setPresets(items);
      setPresetError(undefined);
    }, (error: unknown) => {
      if (current) setPresetError(error instanceof Error ? error.message : String(error));
    });
    if (readConnections) {
      void readConnections().then(({ connections: inventory }) => {
        if (!current) return;
        setConnections(inventory);
        setConnectionError(false);
      }, () => {
        if (!current) return;
        setConnections(undefined);
        setConnectionError(true);
      });
    } else {
      setConnectionError(true);
    }
    return () => { current = false; };
  }, [manage, readConnections]);

  return { manage, presets, setPresets, connections, connectionError, presetError };
}
