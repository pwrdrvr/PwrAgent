// Numeric event codes keep the update path free of event-object allocations.
export const RendererUpdateEvent = {
  composerChange: 0,
  editorPublish: 1,
  editorNormalize: 2,
  editorControlledSync: 3,
  editorControlledPublish: 4,
  contextCardClear: 5,
  contextCardRefresh: 6,
  tooltipHide: 7,
  tooltipShow: 8,
  tooltipUpdate: 9,
  tooltipReposition: 10,
} as const;

export type RendererUpdateEventCode = typeof RendererUpdateEvent[keyof typeof RendererUpdateEvent];
export const RENDERER_UPDATE_EVENT_NAMES = Object.keys(RendererUpdateEvent);
export const RENDERER_UPDATE_CAPACITY = 64;

export type RendererUpdateSnapshot = {
  version: 1;
  capacity: number;
  capturedAtMs: number;
  total: number;
  counts: number[];
  events: {
    event: RendererUpdateEventCode;
    scope: string;
    firstMs: number;
    lastMs: number;
    count: number;
  }[];
};
