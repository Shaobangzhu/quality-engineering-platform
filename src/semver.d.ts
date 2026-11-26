declare module 'semver' {
  export function satisfies(version: string, range: string): boolean;
  export function valid(version: string): string | null;
}
