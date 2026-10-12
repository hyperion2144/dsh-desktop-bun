#!/usr/bin/env node
// 装配随包内置 dsh 运行时（独立仓版；Electrobun 壳没有 Node sidecar，只装依赖树）。
// 用法: node scripts/prepare-builtin-runtime.mjs --variant latest
// 产物（gitignore，不入库）: resources/builtin/node_modules + desktop-runtime.json
// CI: build.yml 在 prepare:bundle 之前跑一次（prepare-bundle 的来源链：
//     DSH_SHELL_BUILTIN_SOURCE > resources/builtin > 本机已下载运行时）。
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const target = join(repoRoot, "resources", "builtin");
const stage = join(repoRoot, ".builtin-stage");

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const variant = opt("--variant", "latest");
// 内置 dsh 的版本（pin，不浮动）：升级 = 改这一行（或 --dsh-version 临时覆盖）。
const BUILTIN_DSH_VERSION = "0.2.1-alpha.2";
const dshVersion = opt("--dsh-version", BUILTIN_DSH_VERSION);

const log = (m) => console.log(`[builtin-runtime] ${m}`);
const die = (m) => { console.error(`[builtin-runtime] ${m}`); process.exit(1); };

log(`内置 dsh 版本（pin）= ${dshVersion}（variant = ${variant}）`);
mkdirSync(stage, { recursive: true });
writeFileSync(join(stage, "package.json"), JSON.stringify({ private: true }));
// pnpm 固定精确版本：它是内置工具链的一部分，决定 profile 依赖的 store 大版本
//（浮动会让不同时间构建出不同 store 版本 → ERR_PNPM_UNEXPECTED_STORE，#119/#122）。
execSync(`npm install --no-save --no-audit --no-fund @deepseek-ai/dsh@${dshVersion} pnpm@11.16.0`, {
  cwd: stage, stdio: "inherit",
});

rmSync(target, { recursive: true, force: true });
cpSync(join(stage, "node_modules"), join(target, "node_modules"), { recursive: true, verbatimSymlinks: true });
writeFileSync(
  join(target, "desktop-runtime.json"),
  JSON.stringify({ variant, dsh: dshVersion, staged_at: new Date().toISOString() }, null, 2),
);
rmSync(stage, { recursive: true, force: true });
log(`dsh 依赖树已就位：${target}`);
