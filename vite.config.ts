import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_PORT ?? 5173),
      proxy: env.VITE_MCP_PROXY
        ? {
            '/mcp': {
              target: env.VITE_MCP_PROXY,
              changeOrigin: true,
              secure: false,
            },
          }
        : undefined,
    },
    define: {
      __APP_VERSION__: JSON.stringify(env.npm_package_version ?? '0.0.0'),
    },
  };
});
