// Minimal ambient declarations for the `bun:test` APIs used by tests.
// This repo's tsconfig ships no bun types; the runtime import resolves
// under `bun test`. Keep in sync with actual usage only.
declare module 'bun:test' {
  export const mock: {
    module(path: string, factory: () => unknown): void;
  };
}
