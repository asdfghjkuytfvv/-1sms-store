import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
const source = "node_modules/three/examples/jsm/libs/basis";
const destination = "public/basis";
if (existsSync(source)) {
  await mkdir("public", { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
} else {
  console.warn("Three.js Basis transcoder directory not found; KTX2 models will require public/basis assets.");
}
