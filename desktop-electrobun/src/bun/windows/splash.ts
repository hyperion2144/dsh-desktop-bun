// 启动界面（splash）：壳还在起宿主的那 10–60 秒里，用户看到的是它，而不是空白窗口。
//
// 这里只有**纯的 HTML 与注入脚本**（不 import electrobun）——窗口在 index.ts 里建，
// 这样缝 ② 能直接断言文案/转义/进度，无显示器也能跑。
//
// 与页面的接口：HTML 里挂 `window.__dshSplash = { stage(text, percent), fail(message) }`；
// 主进程用 webview.executeJavascript 推阶段（见 splashStageScript / splashFailScript）。

import { APP_NAME } from '../../shared/app/app.ts'
import { FAILED_LABEL, stageLabel, stagePercent, type ShellStage } from '../platform/stages.ts'
import { dialogTitlebar, dialogTitlebarStyle } from './dialog-titlebar.ts'
import type { CarrierPlatform } from './carrier.ts'
import {
  DEFAULT_SHELL_THEME,
  shellThemeAttr,
  shellThemeStyle,
  type ShellThemePreference,
} from '../../shared/settings/shell-theme.ts'

export const SPLASH_WIDTH = 420
export const SPLASH_HEIGHT = 236

/** 把任意文案塞进 JS 字符串字面量（阶段/错误信息都可能带引号）。 */
function jsString(value: string): string {
  return JSON.stringify(value)
}

export function splashStageScript(stage: ShellStage): string {
  return `window.__dshSplash && window.__dshSplash.stage(${jsString(stageLabel(stage))}, ${String(stagePercent(stage))})`
}

export function splashFailScript(message: string): string {
  return `window.__dshSplash && window.__dshSplash.fail(${jsString(message)})`
}

  // 跟产品主题走：读 profile 的 ui-theme 偏好，没配就跟随系统（= DSH 的缺省口径）。
  // 配色走 CSS 变量 + prefers-color-scheme，所以系统切深浅色时这扇窗不用重开就能跟上。
export function splashHtml(
  theme: ShellThemePreference = DEFAULT_SHELL_THEME,
  // #164：win32/linux 上 hiddenInset 没有原生控件，splash 也画一条拖拽带（**不给 ✕**：它自动关，
  // 给了关闭键是给假承诺）；darwin 有系统红绿灯，默认按 darwin 算。
  platform: CarrierPlatform = 'darwin',
): string {
  const band = dialogTitlebar({ platform, title: APP_NAME, close: false })
  const bandCss =
    band.html === ''
      ? ''
      : [
          dialogTitlebarStyle(),
          '  body { position: relative; padding-top: 32px; }',
        ].join('\n')
  return `<!doctype html>
<html lang="zh-CN"${shellThemeAttr(theme)}>
<head>
<meta charset="utf-8" />
<title>${APP_NAME}</title>
<style>
${shellThemeStyle()}
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; background: var(--dsw-alias-bg-layer-1, #16161a); color: var(--dsw-alias-label-primary, #e7e7ea);
    font: 13px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  .name { font-size: 15px; font-weight: 600; letter-spacing: .02em; }
  .stage { color: var(--dsw-alias-label-secondary, #9a9aa2); min-height: 20px; }
  .track { width: 260px; height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l2, #2a2a31); overflow: hidden; }
  .bar { height: 100%; width: 4%; border-radius: 2px; background: var(--dsw-alias-state-accent-primary, #6c7bff); transition: width .18s ease; }
  .error { display: none; max-width: 340px; text-align: center; color: var(--dsw-alias-state-danger, #ff8b8b); white-space: pre-wrap; }
  .hint { display: none; max-width: 340px; text-align: center; color: var(--dsw-alias-label-secondary, #7c7c85); font-size: 12px; }
  body.failed .track { display: none; }
  body.failed .error, body.failed .hint { display: block; }
${bandCss}
</style>
</head>
<body${band.bodyClass === '' ? '' : ` class="${band.bodyClass.trim()}"`}>
${band.html}
  <div class="name">${APP_NAME}</div>
  <div class="stage" id="stage">正在启动…</div>
  <div class="track"><div class="bar" id="bar"></div></div>
  <div class="error" id="error"></div>
  <div class="hint" id="hint">托盘已就绪：可在托盘里换运行时版本或退出；日志在 ~/.dsh/shell.log</div>
  <script>
    window.__dshSplash = {
      stage: function (text, percent) {
        var stage = document.getElementById('stage')
        var bar = document.getElementById('bar')
        if (stage) stage.textContent = text
        if (bar && typeof percent === 'number') bar.style.width = Math.max(4, Math.min(100, percent)) + '%'
      },
      fail: function (message) {
        document.body.classList.add('failed')
        var stage = document.getElementById('stage')
        var error = document.getElementById('error')
        if (stage) stage.textContent = ${jsString(FAILED_LABEL)}
        if (error) error.textContent = message
      },
    }
  </script>
</body>
</html>`
}
