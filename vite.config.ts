import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    outDir: "dist",
    target: "esnext",
    // Use terser for better obfuscation
    minify: "terser",
    terserOptions: {
      compress: {
        drop_console: true,      // Remove console.log
        drop_debugger: true,     // Remove debugger statements
        pure_funcs: ["console.log", "console.info", "console.debug", "console.warn"],
        passes: 2,               // Multiple compression passes
      },
      mangle: {
        toplevel: true,          // Mangle top-level names
        properties: {
          regex: /^_/,           // Mangle properties starting with _
        },
      },
      format: {
        comments: false,         // Remove all comments
      },
    },
    // Disable source maps in production
    sourcemap: false,
    // Randomize chunk names
    rollupOptions: {
      output: {
        manualChunks: undefined,
        chunkFileNames: "assets/[hash].js",
        entryFileNames: "assets/[hash].js",
        assetFileNames: "assets/[hash].[ext]",
      },
    },
  },

  // Disable source maps for CSS as well
  css: {
    devSourcemap: false,
  },
});
