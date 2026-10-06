// Minimal local typing: @types/js-yaml is not available offline. Only `load` and
// the CORE_SCHEMA are used (see ingestion/VaultImporter.ts).
declare module 'js-yaml' {
  export interface LoadOptions { schema?: unknown }
  export const CORE_SCHEMA: unknown;
  export function load(input: string, options?: LoadOptions): unknown;
}
