/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OrchestrationStack's HttpApiUrl output — base for POST /run and GET /status/{runId}. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
