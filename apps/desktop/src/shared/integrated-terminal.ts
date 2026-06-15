export type IntegratedTerminalCreateRequest = {
  threadKey: string;
  cwd?: string;
  cols: number;
  rows: number;
};

export type IntegratedTerminalCreateResponse = {
  sessionId: string;
  threadKey: string;
  cwd: string;
  shell: string;
  pid?: number;
  buffer?: string;
};

export type IntegratedTerminalWriteRequest = {
  sessionId: string;
  data: string;
};

export type IntegratedTerminalResizeRequest = {
  sessionId: string;
  cols: number;
  rows: number;
};

export type IntegratedTerminalCloseRequest = {
  sessionId?: string;
  threadKey?: string;
};

export type IntegratedTerminalOutputEvent = {
  sessionId: string;
  data: string;
};

export type IntegratedTerminalExitEvent = {
  sessionId: string;
  exitCode: number | null;
  signal: number | string | null;
};

export type IntegratedTerminalErrorEvent = {
  sessionId?: string;
  message: string;
};
