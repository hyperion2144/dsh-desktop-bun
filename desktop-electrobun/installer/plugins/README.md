# NSIS 插件（仓内自持）

CI 的 windows-latest 镜像 NSIS 不带第三方插件，插件 dll 直接提交进仓，构建脚本用
`!addplugindir` 挂载本目录。

## WinShell.dll（x86-unicode）

- 用途：给开始菜单快捷方式写 AppUserModelID（`WinShell::SetLnkAUMI`）。没有它，
  任务栏固定项与应用无法按 AUMID 关联——应用退出后点固定图标拉不起来（#199）。
- 来源：electron-builder-binaries `nsis@2.0.1` bundle 的 `windows/Plugins/x86-unicode/`
  （electron-builder 官方 NSIS 模板同款分发物，官方模板用 `WinShell::SetLnkAUMI /
  UninstShortcut / UninstAppUserModelId` 完成同一件事）。
- 目标架构：NSIS 3 默认 Unicode x86 目标；改 amd64-unicode 目标时需换对应变体。
