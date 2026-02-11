import { defineConfig } from 'vite';

export default defineConfig({
  assetsInclude: ['**/*.vert', '**/*.frag'],
  server: {
    port: 5173,
    open: true,
  },
});
