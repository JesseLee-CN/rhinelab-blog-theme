// 功能模块边界守卫（features.manifest.json 是唯一事实来源）。
//
// 它回答一个问题：把某个功能整体删掉时，仓库是否还能自洽？因此它不检查
// “功能是否工作”，而是检查模块边界是否被绕过：
//   1. 清单与磁盘一致：目录、入口、样式文件、公开导出、npm 检查命令都存在。
//   2. 外部只走入口：src/ 中功能目录之外的文件只能 `./features/<id>` 引用功能，
//      不允许深入功能内部路径。
//   3. 功能之间不互相穿透：一个功能不得引用另一个功能的任何文件。
//   4. 功能自带清单：功能目录里的每个源文件都必须被入口、样式入口或同目录
//      引用链覆盖，避免删除功能后留下无人引用的孤儿文件。
//
// 用法：node scripts/check-features.mjs [--json]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const asJson = process.argv.includes("--json");
const problems = [];
const notes = [];

const manifest = JSON.parse(readFileSync(resolve(root, "features.manifest.json"), "utf8"));
const features = manifest.features ?? [];
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

const posix = (value) => value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
/** 只把源码文件算进功能目录（README.md 之类的说明文件不参与边界判定）。 */
const SOURCE = /\.(ts|css)$/;
const listFiles = (dir) => {
  const found = [];
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !SOURCE.test(entry.name)) continue;
    const parent = entry.parentPath ? relative(resolve(root, dir), entry.parentPath) : "";
    found.push(posix(parent ? `${dir}/${parent}/${entry.name}` : `${dir}/${entry.name}`));
  }
  return found.sort();
};
const exists = (rel) => {
  try {
    statSync(resolve(root, rel));
    return true;
  } catch {
    return false;
  }
};
const isFile = (rel) => {
  try {
    return statSync(resolve(root, rel)).isFile();
  } catch {
    return false;
  }
};
/** 收集一段源码里的所有相对规格说明符（`@import` 必须排在 `^import` 之前，否则行首匹配被吃掉）。 */
const specifiers = (body) => {
  const found = [];
  for (const match of body.matchAll(/(?:from\s+"|@import\s+"|^import\s+"|import\(")(\.[^"]+)"/gm)) found.push(match[1]);
  return found;
};
const resolveSpecifier = (fromFile, spec) => {
  const target = resolve(root, dirname(resolve(root, fromFile)), spec);
  for (const candidate of [`${target}.ts`, `${target}.css`, `${target}/index.ts`, target]) {
    if (isFile(relative(root, candidate))) return posix(relative(root, candidate));
  }
  return null;
};

/**
 * 取出 snapshot() 的对象字面量（两种写法：`snapshot: () => ({…})` 与
 * `function snapshot(): T { return {…} }`）。按花括号配对截取，够用且不依赖格式。
 */
const snapshotScope = (body) => {
  const match = /(?:snapshot\s*:\s*\(\)\s*=>\s*\(?|function\s+snapshot\s*\([^)]*\)[^{]*)\{/.exec(body);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = start; index < body.length; index += 1) {
    if (body[index] === "{") depth += 1;
    else if (body[index] === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, index + 1);
    }
  }
  return null;
};

const featureDirs = features.map((feature) => posix(feature.dir));
const dirOf = (file) => featureDirs.find((dir) => file === dir || file.startsWith(`${dir}/`));

// 1. 清单与磁盘一致
for (const feature of features) {
  const id = feature.id;
  if (!exists(feature.dir)) problems.push(`[${id}] 目录不存在：${feature.dir}`);
  if (!exists(feature.entry)) problems.push(`[${id}] 入口不存在：${feature.entry}`);
  for (const style of feature.styles ?? []) {
    if (!exists(`${feature.dir}/${style}`)) problems.push(`[${id}] 样式文件不存在：${feature.dir}/${style}`);
  }
  const entryBody = exists(feature.entry) ? readFileSync(resolve(root, feature.entry), "utf8") : "";
  const featureFiles = exists(feature.dir) ? listFiles(feature.dir) : [];
  for (const name of feature.publicApi ?? []) {
    if (!new RegExp(`\\b${name}\\b`).test(entryBody)) problems.push(`[${id}] 入口未导出声明的公开 API：${name}`);
  }
  for (const check of feature.checks ?? []) {
    if (!scripts[check]) problems.push(`[${id}] package.json 缺少声明的检查命令：npm run ${check}`);
  }
  for (const dir of [feature.serverSide, feature.ops, feature.scripts, feature.shared, feature.surfaces, feature.docs].flat()) {
    if (!exists(dir)) problems.push(`[${id}] 清单声明的路径不存在：${dir}`);
  }
  if (feature.eager !== true && feature.eager !== false) problems.push(`[${id}] 缺少 eager 布尔字段`);
  if (!feature.hostPort) problems.push(`[${id}] 缺少 hostPort 声明`);
  // 审阅契约是 `window.rhine.stats()` 的键名，`scripts/**` 里有大量读者。
  // 改键名不会报编译错误，只会让这些检查静默超时，所以在这里钉住。
  if (feature.reviewContract?.length) {
    const snapshot = featureFiles
      .map((file) => snapshotScope(readFileSync(resolve(root, file), "utf8")))
      .find(Boolean);
    if (!snapshot) problems.push(`[${id}] 功能目录中没有 snapshot() 字面量，无法校验 reviewContract`);
    else {
      for (const key of feature.reviewContract) {
        if (!new RegExp(`(^|[^\\w])${key}\\s*[,:]`, "m").test(snapshot)) {
          problems.push(`[${id}] reviewContract 声明的键不在 snapshot() 里：${key}`);
        }
      }
    }
  }
  notes.push(
    `[${id}] ${feature.title}｜目录 ${feature.dir}｜${feature.eager ? "首屏静态引入" : "按需加载"}｜宿主端口 ${feature.hostPort}｜检查 ${(feature.checks ?? []).length} 条`,
  );
}

// 2 + 3. 外部只走入口；功能之间不互相穿透
const sourceFiles = [...listFiles("src"), ...listFiles("shared")];
for (const file of sourceFiles) {
  const owner = dirOf(file);
  const body = readFileSync(resolve(root, file), "utf8");
  for (const spec of specifiers(body)) {
    const target = resolveSpecifier(file, spec);
    if (!target) {
      problems.push(`[import] ${file} → ${spec} 无法解析`);
      continue;
    }
    const targetOwner = dirOf(target);
    if (owner && targetOwner === owner) {
      // 功能内部引用：允许，但不得跨到别的功能
      continue;
    }
    if (owner && targetOwner && targetOwner !== owner) {
      problems.push(`[cross-feature] ${file} 引用了另一个功能内部文件 ${target}`);
      continue;
    }
    if (owner && !targetOwner) continue; // 功能依赖核心或 shared：允许
    if (!owner && targetOwner) {
      const expected = `${targetOwner}/index.ts`;
      if (target !== expected) {
        problems.push(`[deep-import] ${file} 深入功能内部：${spec}（应从 ${expected} 引用）`);
      }
    }
  }
}

// 4. 功能目录内没有孤儿文件（每个文件都被入口/样式入口的引用链覆盖）
for (const feature of features) {
  const dir = posix(feature.dir);
  const files = listFiles(dir);
  const reachable = new Set();
  const visit = (file) => {
    if (reachable.has(file)) return;
    reachable.add(file);
    const body = readFileSync(resolve(root, file), "utf8");
    for (const spec of specifiers(body)) {
      const target = resolveSpecifier(file, spec);
      if (target && target.startsWith(`${dir}/`)) visit(target);
    }
  };
  for (const declared of [feature.entry, feature.styleEntry]) {
    if (declared && exists(declared)) visit(posix(declared));
  }
  // 入口里 `import "./x.css"` 这类样式引用也算已覆盖
  const orphans = files.filter((file) => !reachable.has(file));
  if (orphans.length) problems.push(`[${feature.id}] 以下文件没有任何入口引用链覆盖：\n    ${orphans.join("\n    ")}`);
  notes.push(`[${feature.id}] 文件 ${files.length} 个，全部被入口或样式入口覆盖`);
}

const report = { features: features.map((feature) => feature.id), problems, notes, passed: problems.length === 0 };
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const note of notes) console.log(`  ${note}`);
  if (problems.length) {
    console.error(`\n功能边界检查未通过（${problems.length} 项）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
  } else {
    console.log(`\n功能边界检查通过：${features.length} 个功能，入口唯一、无跨功能穿透、无孤儿文件。`);
  }
}
process.exit(problems.length === 0 ? 0 : 1);
