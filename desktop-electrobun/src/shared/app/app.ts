// 应用名（单一来源）：构建配置、窗口标题、macOS 应用菜单都用它。
//
// 「BUN」后缀是**临时**的区分手段：Bun 运行时壳与旧 Node/Tauri 壳会并存一段时间，
// 名字不同才能在 Dock、菜单栏、/Applications 里一眼分得开（bundle id 不变，仍共用
// ~/.dsh 与运行时树）。等旧壳下线后去掉后缀。
export const APP_NAME = 'DeepSeek Harness Desktop BUN'
// Windows 侧应用 id（AUMID，与安装器 APP_ID 同源，#107）：通知身份注册用它；
// 改名须与 scripts/build-windows-installer.mjs 的 !define APP_ID 同步（防漂移断言在
// test/win-notify-identity.test.ts）。
export const APP_ID = 'DeepSeekHarnessDesktopBUN'
