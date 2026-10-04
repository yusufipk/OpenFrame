// fengari ships no type declarations; the tests use it only through tests/helpers/lua.ts.
declare module 'fengari' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const lua: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const lauxlib: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const lualib: any;
  export function to_luastring(value: string): Uint8Array;
  export function to_jsstring(value: Uint8Array): string;
}
