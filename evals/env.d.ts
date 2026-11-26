declare namespace NodeJS {
  interface Process {
    readonly resourcesPath?: string;
    readonly defaultApp?: boolean;
  }
}
