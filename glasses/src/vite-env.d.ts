interface ImportMetaEnv {
  /**
   * Hub origin baked into a packed build. Unset during development, where the
   * app derives the hub from whatever host served it.
   */
  readonly VITE_HUB_URL?: string
}

interface ImportMeta {
  readonly env?: ImportMetaEnv
}

/** App version from app.json, injected at build time by vite.config.ts. */
declare const __APP_VERSION__: string
