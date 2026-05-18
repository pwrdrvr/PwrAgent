declare module "*.css";

// Fontsource CSS-only packages — bare side-effect imports register
// @font-face declarations and bundle the .woff2 files via Vite's CSS
// pipeline. There are no runtime exports, so a side-effect-only module
// shim is the right shape.
declare module "@fontsource-variable/geist";
declare module "@fontsource-variable/geist-mono";

declare module "*.svg" {
  const url: string;
  export default url;
}

declare module "*.png" {
  const url: string;
  export default url;
}
