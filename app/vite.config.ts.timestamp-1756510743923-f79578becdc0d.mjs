// vite.config.ts
import { defineConfig } from "file:///Users/michaelgoldstein/opus/app/node_modules/vite/dist/node/index.js";
import path from "node:path";
import electron from "file:///Users/michaelgoldstein/opus/app/node_modules/vite-plugin-electron/dist/simple.mjs";
import react from "file:///Users/michaelgoldstein/opus/app/node_modules/@vitejs/plugin-react/dist/index.js";
import tailwindcss from "file:///Users/michaelgoldstein/opus/app/node_modules/@tailwindcss/vite/dist/index.mjs";
var __vite_injected_original_dirname = "/Users/michaelgoldstein/opus/app";
var vite_config_default = defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: "electron/main.ts",
        vite: {
          build: {
            rollupOptions: {
              external: ["bufferutil", "utf-8-validate", "terminator.js"]
            }
          }
        }
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__vite_injected_original_dirname, "electron/preload.ts")
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === "test" ? (
        // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        void 0
      ) : {}
    }),
    tailwindcss()
  ]
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvbWljaGFlbGdvbGRzdGVpbi9vcHVzL2FwcFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21pY2hhZWxnb2xkc3RlaW4vb3B1cy9hcHAvdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL1VzZXJzL21pY2hhZWxnb2xkc3RlaW4vb3B1cy9hcHAvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IGVsZWN0cm9uIGZyb20gXCJ2aXRlLXBsdWdpbi1lbGVjdHJvbi9zaW1wbGVcIjtcbmltcG9ydCByZWFjdCBmcm9tIFwiQHZpdGVqcy9wbHVnaW4tcmVhY3RcIjtcbmltcG9ydCB0YWlsd2luZGNzcyBmcm9tIFwiQHRhaWx3aW5kY3NzL3ZpdGVcIjtcblxuLy8gaHR0cHM6Ly92aXRlanMuZGV2L2NvbmZpZy9cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHBsdWdpbnM6IFtcbiAgICByZWFjdCgpLFxuICAgIGVsZWN0cm9uKHtcbiAgICAgIG1haW46IHtcbiAgICAgICAgLy8gU2hvcnRjdXQgb2YgYGJ1aWxkLmxpYi5lbnRyeWAuXG4gICAgICAgIGVudHJ5OiBcImVsZWN0cm9uL21haW4udHNcIixcbiAgICAgICAgdml0ZToge1xuICAgICAgICAgIGJ1aWxkOiB7XG4gICAgICAgICAgICByb2xsdXBPcHRpb25zOiB7XG4gICAgICAgICAgICAgIGV4dGVybmFsOiBbXCJidWZmZXJ1dGlsXCIsIFwidXRmLTgtdmFsaWRhdGVcIiwgXCJ0ZXJtaW5hdG9yLmpzXCJdXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgcHJlbG9hZDoge1xuICAgICAgICAvLyBTaG9ydGN1dCBvZiBgYnVpbGQucm9sbHVwT3B0aW9ucy5pbnB1dGAuXG4gICAgICAgIC8vIFByZWxvYWQgc2NyaXB0cyBtYXkgY29udGFpbiBXZWIgYXNzZXRzLCBzbyB1c2UgdGhlIGBidWlsZC5yb2xsdXBPcHRpb25zLmlucHV0YCBpbnN0ZWFkIGBidWlsZC5saWIuZW50cnlgLlxuICAgICAgICBpbnB1dDogcGF0aC5qb2luKF9fZGlybmFtZSwgXCJlbGVjdHJvbi9wcmVsb2FkLnRzXCIpXG4gICAgICB9LFxuICAgICAgLy8gUGxveWZpbGwgdGhlIEVsZWN0cm9uIGFuZCBOb2RlLmpzIEFQSSBmb3IgUmVuZGVyZXIgcHJvY2Vzcy5cbiAgICAgIC8vIElmIHlvdSB3YW50IHVzZSBOb2RlLmpzIGluIFJlbmRlcmVyIHByb2Nlc3MsIHRoZSBgbm9kZUludGVncmF0aW9uYCBuZWVkcyB0byBiZSBlbmFibGVkIGluIHRoZSBNYWluIHByb2Nlc3MuXG4gICAgICAvLyBTZWUgXHVEODNEXHVEQzQ5IGh0dHBzOi8vZ2l0aHViLmNvbS9lbGVjdHJvbi12aXRlL3ZpdGUtcGx1Z2luLWVsZWN0cm9uLXJlbmRlcmVyXG4gICAgICByZW5kZXJlcjpcbiAgICAgICAgcHJvY2Vzcy5lbnYuTk9ERV9FTlYgPT09IFwidGVzdFwiXG4gICAgICAgICAgPyAvLyBodHRwczovL2dpdGh1Yi5jb20vZWxlY3Ryb24tdml0ZS92aXRlLXBsdWdpbi1lbGVjdHJvbi1yZW5kZXJlci9pc3N1ZXMvNzgjaXNzdWVjb21tZW50LTIwNTM2MDA4MDhcbiAgICAgICAgICAgIHVuZGVmaW5lZFxuICAgICAgICAgIDoge31cbiAgICB9KSxcbiAgICB0YWlsd2luZGNzcygpXG4gIF1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFrUixTQUFTLG9CQUFvQjtBQUMvUyxPQUFPLFVBQVU7QUFDakIsT0FBTyxjQUFjO0FBQ3JCLE9BQU8sV0FBVztBQUNsQixPQUFPLGlCQUFpQjtBQUp4QixJQUFNLG1DQUFtQztBQU96QyxJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTO0FBQUEsSUFDUCxNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsTUFDUCxNQUFNO0FBQUE7QUFBQSxRQUVKLE9BQU87QUFBQSxRQUNQLE1BQU07QUFBQSxVQUNKLE9BQU87QUFBQSxZQUNMLGVBQWU7QUFBQSxjQUNiLFVBQVUsQ0FBQyxjQUFjLGtCQUFrQixlQUFlO0FBQUEsWUFDNUQ7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxNQUNBLFNBQVM7QUFBQTtBQUFBO0FBQUEsUUFHUCxPQUFPLEtBQUssS0FBSyxrQ0FBVyxxQkFBcUI7QUFBQSxNQUNuRDtBQUFBO0FBQUE7QUFBQTtBQUFBLE1BSUEsVUFDRSxRQUFRLElBQUksYUFBYTtBQUFBO0FBQUEsUUFFckI7QUFBQSxVQUNBLENBQUM7QUFBQSxJQUNULENBQUM7QUFBQSxJQUNELFlBQVk7QUFBQSxFQUNkO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
