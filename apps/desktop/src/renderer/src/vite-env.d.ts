// Minimal typing for Vite's compile-time env constants (the renderer doesn't
// pull in the full `vite/client` types). `import.meta.env.DEV` is `true` under
// `pnpm dev` and `false` in production builds.
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";

declare module "*.svg" {
  const url: string;
  export default url;
}

declare module "*.png" {
  const url: string;
  export default url;
}
