#!/usr/bin/env bun
// 物化树版本闸（#68）：dev / test / prepare:bundle 前置。
//
// 声明（builtin-runtime.json）是供给唯一事实源；仓内物化树是 gitignore 的本地产物，
// 声明升级后它不会自动跟着变。常见后果：声明已经是 rc.2，本地仍跑 alpha.2——
// 「bootstrap 首载 404」的宿主侧修复明明在声明版本里，本地却复现不出来/照样踩。
//
// 这里在需要树的脚本前 fail-fast；树根本不存在时跳过（需要树的命令自己会报错/物化）。
// 显式 DSH_SHELL_BUILTIN_DIR 指到缺失/不完整的树时直接失败，不静默回退。
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DECLARATION_FILE,
  readBuiltinRuntimeDeclaration,
  verifyBuiltinTree,
} from '../src/shared/runtime/builtin-runtime.ts'

const projectRoot = resolve(import.meta.dir, '..')
const explicit = process.env.DSH_SHELL_BUILTIN_DIR
const tree =
  explicit !== undefined && explicit !== '' ? resolve(explicit) : join(projectRoot, 'builtin-runtime')
const declarationPath = join(projectRoot, DECLARATION_FILE)
const declared = readBuiltinRuntimeDeclaration(declarationPath)
if (declared === null) {
  console.error(
    `[verify-builtin-runtime] 内置运行时声明读不出来：${declarationPath}（应形如 {"dsh":"x.y.z-…","pnpm":"a.b.c"}）`,
  )
  process.exit(1)
}

if (!existsSync(tree)) {
  if (explicit !== undefined && explicit !== '') {
    console.error(`[verify-builtin-runtime] DSH_SHELL_BUILTIN_DIR 指向的树不存在：${tree}`)
    process.exit(1)
  }
  console.log(
    `[verify-builtin-runtime] 无物化树（${tree}），跳过版本核对（需要时先 bun run prepare:bundle）`,
  )
  process.exit(0)
}

const state = verifyBuiltinTree(tree, declared)
if (state.ok) process.exit(0)
console.error(`[verify-builtin-runtime] 物化树与 ${DECLARATION_FILE} 不一致：${tree}`)
for (const problem of state.problems) console.error(`  - ${problem}`)
console.error(
  '[verify-builtin-runtime] 声明是供给唯一事实源；请按声明重新物化（bun run prepare:bundle --force）',
)
process.exit(1)
