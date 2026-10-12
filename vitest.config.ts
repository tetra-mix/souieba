import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // テストから npm に新しい版を問い合わせない（子プロセスの CLI にも引き継がれる）
    env: { SOUIEBA_NO_UPDATE_CHECK: "1" },
  },
});
