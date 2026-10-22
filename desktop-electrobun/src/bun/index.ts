// 壳 bundle 唯一入口（electrobun.config entrypoint → app/bun/index.js）。
//
// launcher 占用的进程 = 主进程（缺省角色）：零窗、不建托盘、只管理壳进程
// （拉起/杀掉/重启/watchdog）——它就是原「临时监督守护进程」常驻化后提到
// 启动链最前面的形态（map #240 / #243）。
//
// 壳进程由主进程用专门的拉起方法 spawn（env DSH_SHELL_ROLE=shell 指路），
// 桌面全流程（多窗口 + 托盘 + DSH + 服务面）整体住在 desktop-shell.ts——
// 入口只做一次角色路由，业务代码里不出现守护/壳分支（#243 拍板）。


export { }
const role = process.env.DSH_SHELL_ROLE === 'shell' ? 'shell' : 'main'

if (role === 'shell') {
  // 壳：桌面全流程（多窗口实现保持不变）。
  await import('./desktop-shell.ts')
} else {
  // 主进程：进程编排（拉壳/杀壳/重启/watchdog/激活让位）。
  await import('./main-process.ts')
}
