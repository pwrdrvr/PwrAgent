declare module "*.md?raw" {
  const value: string;
  export default value;
}

// Supporting files of bundled skills, served as text.
declare module "*.sh?raw" {
  const value: string;
  export default value;
}

declare module "*.mjs?raw" {
  const value: string;
  export default value;
}

declare module "*/Dockerfile?raw" {
  const value: string;
  export default value;
}
