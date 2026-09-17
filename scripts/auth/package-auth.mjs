// LOGIN-IMPROVE L4a auth release packaging: builds the linux/amd64 binary and
// emits an immutable release unit (binary + openapi + manifest + checksums).
// Never includes databases, config or keys.
//
// An existing id is refused, not deleted or overwritten. The manifest carries
// the register-v1 feature and a hash set over the complete controlled source
// list (tracked *and* untracked-not-ignored files), so a dirty build is
// traceable instead of being mislabelled as HEAD.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i].startsWith("--")) args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const version = args.get("version");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: package-auth.mjs --version <x.y.z> [--id <x.y.z-gitsha>] [--out-root release/auth]");
  process.exit(2);
}

const serviceDir = resolve("services/lab-auth");
const outRoot = resolve(args.get("out-root") ?? "release/auth");
if (basename(outRoot) !== "auth") {
  console.error(`refusing out-root ${outRoot}: the release root must be a directory named "auth"`);
  process.exit(2);
}
const id = args.get("id") ?? `${version}-${git("rev-parse", "--short", "HEAD")}`;
const releaseDir = resolve(outRoot, id);
const tarball = resolve(outRoot, `${id}.tar.gz`);
for (const target of [releaseDir, tarball]) {
  if (!target.startsWith(outRoot + sep)) {
    console.error(`refusing target outside ${outRoot}: ${target}`);
    process.exit(2);
  }
}
if (existsSync(releaseDir) || existsSync(tarball)) {
  console.error(`refusing to overwrite existing artifact ${id} (${releaseDir}${existsSync(tarball) ? `, ${tarball}` : ""})`);
  process.exit(2);
}
if (!existsSync(join(serviceDir, "go.mod"))) {
  console.error(`missing ${serviceDir}/go.mod; run from the repository root`);
  process.exit(2);
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sha256Text = (text) => createHash("sha256").update(text).digest("hex");
function git(...argv) {
  return execFileSync("git", argv, { encoding: "utf8" }).trim();
}

const stage = mkdtempSync(join(tmpdir(), "lab-auth-package-"));
try {
  const stagedBinary = resolve(stage, "lab-auth");
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", stagedBinary, "./cmd/lab-auth"], {
    cwd: serviceDir,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: "amd64" },
  });
  const reported = spawnSync(stagedBinary, ["version"], { encoding: "utf8" }).stdout?.trim();
  if (reported !== version) {
    console.error(`binary version ${reported} does not match requested --version ${version}`);
    process.exit(1);
  }
  const openapiSource = join(serviceDir, "openapi.yaml");
  const openapiBody = readFileSync(openapiSource, "utf8");
  if (!openapiBody.includes("register-v1")) {
    console.error("openapi.yaml is missing the register-v1 contract");
    process.exit(1);
  }

  mkdirSync(releaseDir, { recursive: true });
  copyFileSync(stagedBinary, resolve(releaseDir, "lab-auth"));
  copyFileSync(openapiSource, resolve(releaseDir, "openapi.yaml"));

  const sourceFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "services/lab-auth"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((file) => !/(\.db(-wal|-shm)?|\.env|\.pem|\.key)$/i.test(file))
    .sort();
  const files = sourceFiles.map((file) => ({ path: file, sha256: sha256(resolve(file)) }));
  const worktreeSha256 = sha256Text(files.map((file) => `${file.path} ${file.sha256}\n`).join(""));
  const dirty = git("status", "--porcelain", "--", "services/lab-auth") !== "";

  const manifest = {
    artifact: "lab-auth",
    id,
    version,
    builtAt: new Date().toISOString(),
    platform: "linux/amd64",
    api: { major: 1 },
    schema: { version: 1, compatibleFrom: 1 },
    features: ["register-v1"],
    binary: { name: "lab-auth", size: statSync(resolve(releaseDir, "lab-auth")).size, sha256: sha256(resolve(releaseDir, "lab-auth")) },
    source: {
      head: git("rev-parse", "HEAD"),
      dirty,
      worktreeSha256,
      files,
    },
    go: {
      version: execFileSync("go", ["version"], { encoding: "utf8" }).trim(),
      goModSha256: sha256(join(serviceDir, "go.mod")),
      goSumSha256: sha256(join(serviceDir, "go.sum")),
    },
    checksums: { "openapi.yaml": sha256(resolve(releaseDir, "openapi.yaml")) },
  };
  writeFileSync(resolve(releaseDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    resolve(releaseDir, "checksums.txt"),
    `${manifest.binary.sha256}  lab-auth\n${manifest.checksums["openapi.yaml"]}  openapi.yaml\n`,
  );
  execFileSync("tar", ["-czf", tarball, "-C", releaseDir, "."]);
  console.log(
    JSON.stringify(
      { id, releaseDir, tarball, version, dirty, worktreeSha256, binarySha256: manifest.binary.sha256, tarballSha256: sha256(tarball) },
      null,
      2,
    ),
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
