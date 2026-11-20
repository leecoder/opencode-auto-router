import { defineConfig } from "tsup"

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/config.ts",
    "src/classifier.ts",
    "src/config-loader.ts",
    "src/classifiers/bert.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node18",
  external: ["@opencode/plugin", "@huggingface/transformers", "@meridius-labs/apple-on-device-ai"],
})
