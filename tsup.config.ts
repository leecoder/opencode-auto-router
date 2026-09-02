import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/config.ts", "src/classifier.ts", "src/config-loader.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node18",
  external: ["@opencode-ai/plugin"],
})