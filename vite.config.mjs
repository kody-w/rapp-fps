import { defineConfig } from 'vite';

export const chunkBudgetFor = (fileName) => (
  fileName.startsWith('assets/three-') ? 750_000 : 500_000
);

export const enforceChunkBudgets = () => ({
  name: 'enforce-production-chunk-budgets',
  generateBundle(_options, bundle) {
    for (const [fileName, output] of Object.entries(bundle)) {
      if (output.type !== 'chunk') continue;
      const bytes = Buffer.byteLength(output.code);
      const budget = chunkBudgetFor(fileName);
      if (bytes > budget) {
        this.error(
          `${fileName} is ${bytes} bytes; named production budget is ${budget}`,
        );
      }
    }
  },
});

export default defineConfig({
  plugins: [enforceChunkBudgets()],
  server: { port: 5273, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    // The stable Three package entry is one 729k minified module (186k gzip);
    // Vite cannot split a single module without a source alias that costs nine
    // requests and >5% gzip. The plugin above enforces a named 750k exception
    // while keeping every app/post chunk under the stricter 500k ceiling.
    chunkSizeWarningLimit: 750,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'three',
              test: /node_modules\/(?:three|three-mesh-bvh)\//,
            },
            {
              name: 'post',
              test: /node_modules\/(?:postprocessing|n8ao)\//,
            },
          ],
        },
      },
    },
  },
});
