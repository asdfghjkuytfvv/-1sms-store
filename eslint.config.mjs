import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([".next/**", ".next-*/**", ".stage6-build-sandbox/**", "out/**", "build/**", "next-env.d.ts", "public/basis/**"]),
]);
