/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BITRIX_APP_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __LEGACY_APP_VERSION__: string;
