import { defineConfig } from 'tsup';

// Bundlujemy razem z pakietem `shared`, dzięki czemu w obrazie produkcyjnym
// nie trzeba rozwiązywać ścieżek workspace'ów.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: ['@portfolio/shared'],
  external: ['better-sqlite3'],
  banner: {
    // tsup emituje ESM, a niektóre zależności (exceljs) oczekują `require`.
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});
