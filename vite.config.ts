import { defineConfig } from 'vite'

// Like a Makefile rule: tells Vite to produce a single self-contained main.js
// 'iife' = Immediately Invoked Function Expression — wraps everything in a
// closure so the widget code doesn't pollute the rest of the SAC page.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/main.ts',
      name: 'TalkToDataWidget',
      formats: ['iife'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
})
