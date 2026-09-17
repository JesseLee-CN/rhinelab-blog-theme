// Shared loader for repo TypeScript modules from plain Node (no build step).
// The pure timeline/identity modules import extensionless .ts siblings that
// Node ESM cannot resolve, so transpile each file and resolve locals to .ts.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const cache = new Map();

export function loadTs(file) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const requireLocal = (name) => {
    if (!name.startsWith("./"))
      throw new Error(`Only local pure modules are allowed: ${name}`);
    return loadTs(resolve(dirname(file), `${name}.ts`));
  };
  new Function("require", "module", "exports", compiled)(
    requireLocal,
    module,
    module.exports,
  );
  return module.exports;
}
