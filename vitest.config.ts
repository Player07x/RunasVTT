import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: true,
    // Os testes gravam no SQLite de verdade; no runner Windows do workflow
    // Release, centenas de transações passam dos 5 s padrão.
    testTimeout: 30_000,
  },
})
