/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_MCP_ENDPOINT?: string;
  readonly VITE_WIDGET_BASE?: string;
  readonly VITE_MCP_PROXY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
