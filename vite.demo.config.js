import { defineConfig } from 'vitest/config';
import base from './vite.config.js';

// Demo-sandbox build config for the standalone `amlak-demo` deployment.
//
// It reuses the normal build config but points `envDir` at ./demo-env, an empty
// directory with no .env files. Vite therefore loads ZERO Supabase creds (the real
// ones live in .env.local / .env.production at the repo root, which this build never
// reads), so `import.meta.env.REACT_APP_SUPABASE_*` are undefined and the app falls
// into DEMO_MODE (src/lib/supabaseClient.js) — running entirely on the in-memory mock
// seed data, with no path to the real backend.
//
// Build the sandbox with:
//   npx vite build --config vite.demo.config.js --outDir build-demo
export default defineConfig({
  ...base,
  envDir: './demo-env',
});
