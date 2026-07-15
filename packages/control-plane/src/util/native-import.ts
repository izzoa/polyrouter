/**
 * Loads an ESM-only module via Node's NATIVE dynamic import, bypassing
 * TypeScript's downleveling. better-auth ships ESM-only while the control
 * plane compiles to CommonJS; Node 24 loads the ESM graph fine when the import
 * is truly native. The `new Function` indirection keeps transforms from
 * rewriting `import()` into a `require`. (Under Jest, the e2e run enables
 * `--experimental-vm-modules` so this native import is handled by Jest's ESM
 * loader.)
 */
// The Function indirection is the mechanism: it hides import() from TS/Jest
// transforms so Node performs a genuine native dynamic import of the ESM pkg.
export const nativeImport =
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('specifier', 'return import(specifier)') as <T = unknown>(
    specifier: string,
  ) => Promise<T>;
