// 工具链预检（#178 复盘）：壳测试必须在 hutch Bun 1.4.0 下跑。
//
// 系统 PATH 里的 bun 1.3.x 会让 test/devtools.test.ts 的真 FFI、inspector CDP 桥、
// PTC 控制通道出现假失败（skip 数也会从 15 变 21），据此判红是误报。
// pretest / predev 都先过这一关，失败信息直接给出正确工具链路径。

const REQUIRED = '1.4.'
const BUN = process.versions.bun ?? ''

if (BUN === '') {
  console.error('[toolchain] 当前进程不是 Bun；请用 hutch Bun 1.4.0 跑测试：')
  console.error('  ~/.hutch/toolchains/bun/1.4.0/macos-arm64/bun test')
  process.exit(1)
}

if (!BUN.startsWith(REQUIRED)) {
  console.error(`[toolchain] 需要 Bun ${REQUIRED}x（与 hutch / CI 对齐），当前 ${BUN}。`)
  console.error('  用仓库工具链重跑：~/.hutch/toolchains/bun/1.4.0/macos-arm64/bun test')
  process.exit(1)
}

console.log(`[toolchain] Bun ${BUN} OK`)
