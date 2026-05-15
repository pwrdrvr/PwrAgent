export type WindowPointerSnapshot = {
  contentBounds: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  cursor: {
    x: number;
    y: number;
  };
  windowFocused: boolean;
};
