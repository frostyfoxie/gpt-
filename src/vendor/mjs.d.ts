declare module '*.mjs' {
  export interface ParseOptions {
    ecmaVersion?: number | 'latest';
    sourceType?: 'script' | 'module';
    allowAwaitOutsideFunction?: boolean;
    allowReturnOutsideFunction?: boolean;
    allowImportExportEverywhere?: boolean;
  }
  export function parse(input: string, options?: ParseOptions): any;
}
