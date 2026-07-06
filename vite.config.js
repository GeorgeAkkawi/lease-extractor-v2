/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Migrated from Create React App. Two CRA-isms handled here:
//  • JSX lives in .js files (not .jsx). We tell @vitejs/plugin-react to run its
//    Babel transform (automatic JSX runtime — no `import React` needed) on .js too,
//    and let esbuild treat .js as JSX when pre-bundling deps.
//  • Env vars keep the REACT_APP_ prefix, so .env.production / .env.local are
//    unchanged and the production build still picks up the Supabase creds.
export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'REACT_APP_'],
  // Treat .js in src/ as JSX with the automatic runtime (components don't
  // `import React`). esbuild handles the syntax; optimizeDeps mirrors it so dep
  // pre-bundling doesn't choke on any JSX-in-.js.
  esbuild: {
    loader: 'jsx',
    include: /src\/.*\.jsx?$/,
    exclude: [],
    jsx: 'automatic',
  },
  optimizeDeps: {
    esbuildOptions: { loader: { '.js': 'jsx' } },
  },
  server: { port: 3000 },
  build: {
    outDir: 'build', // keep ./build so wrangler.jsonc (assets.directory) is unchanged
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.js'],
    include: ['src/**/*.test.js'],
    // Force DEMO mode in tests. Unlike CRA's runner, Vite loads .env.local in test
    // mode too, which would otherwise inject the real Supabase creds and flip the
    // suite off the mock client (the tests assert DEMO_MODE === true).
    env: { REACT_APP_SUPABASE_URL: '', REACT_APP_SUPABASE_ANON_KEY: '' },
  },
});
