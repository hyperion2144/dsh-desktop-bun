// 会话守卫（iOS/Android 壳，expo-webview）：语义源 = mobile/shell-web/session-guard.mjs。
//
// 背景（#144）：dsh 0.1.7 网关对 `/api/remote.mux` 每 2s Ping、连丢 2 次即 terminate；壳被挂起
// （切后台/锁屏）数秒即被判死，而页面常常收不到 close/error → 「能发消息、收不到新消息」。
// 维护者 2026-09-27 拍板：回前台/网络换代**不整页重载**，先做页面内轻量重连；2026-10-18 修订：
// **回前台不探测不修复**（dsh 客户端自身会重连），探测超时/读不到也**不动作**（弱网常态，
// 强行动手会让页面部分内容重刷）；整页重载只留给渲染崩溃。本文件判定/退避/脚本与共享逻辑源逐字同语义。

/** 探针在页面内的等待上限（毫秒）。弱网隧道下 1.2s 太紧，取 3s（2026-10-18）。 */
export const GUARD_PROBE_TIMEOUT_MS = 3000;
/** 连续失败第几次开始退避。 */
export const BACKOFF_AFTER_FAILURES = 2;
/** 退避基数（毫秒）；#175 缺省从 2s 抬到 10s，可由桌面设置 mobile_guard_backoff_ms 经 pair/info 下发覆盖。 */
export const BACKOFF_BASE_MS = 10000;
/** 退避上限（毫秒）。 */
export const BACKOFF_CAP_MS = 30000;
/** 一次修复动作后的静默期（毫秒）。 */
export const SETTLE_AFTER_REPAIR_MS = 5000;
/** 连续这么多次轻量重连仍不健康 → 升级为兜底整页重载。 */
export const RELOAD_AFTER_RECONNECT_FAILURES = 3;
/** 探针回传标签（RN WebView 只能 postMessage 回读）。 */
export const GUARD_MESSAGE_PREFIX = 'DSH_GUARD:';

export type GuardAction = 'none' | 'wait-network' | 'reconnect' | 'reload';

/** 第 `failures` 次连续失败后的退避时长（毫秒）；`baseMs` 由壳下发（桌面设置 mobile_guard_backoff_ms）。 */
export function backoffDelayMs(failures: number, baseMs: number = BACKOFF_BASE_MS): number {
  if (!Number.isFinite(failures) || failures < BACKOFF_AFTER_FAILURES) return 0;
  const step = failures - BACKOFF_AFTER_FAILURES;
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : BACKOFF_BASE_MS;
  const raw = base * Math.pow(2, step);
  return raw > BACKOFF_CAP_MS ? BACKOFF_CAP_MS : raw;
}

/** 解析探针读数（`信号|在线|套接字`）；解析失败一律 null。 */
export function parseGuardProbeResult(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/^"|"$/g, '');
  if (text.length === 0) return null;
  const match = /^(ds0?|off|null|err)\|([01])\|(\S+)$/.exec(text);
  if (match === null) return null;
  return `${match[1]}|${match[2]}|${match[3]}`;
}

/**
 * 读数 → 动作（先过解析）。语义源同 `mobile/shell-web/session-guard.mjs`。
 * `null` = 页面回了消息但它的探测请求超时（弱网常态）→ 不动作；完全没回消息/残缺 → 不动作。
 * 整页重载只留给渲染崩溃路径（见 use-session-guard 的 onRenderProcessGone）。
 */
export function actionForReading(reading: unknown): GuardAction {
  const parsed = parseGuardProbeResult(reading);
  if (parsed === null) return 'none';
  const signal = parsed.split('|')[0];
  if (signal === 'ds') return 'none';
  if (signal === 'off') return 'wait-network';
  if (signal === 'ds0' || signal === 'err') return 'reconnect';
  return 'none';
}

/** 轻量重连是否应升级为兜底重载。 */
export function shouldEscalateToReload(failures: number, reconnects: number): boolean {
  return failures >= RELOAD_AFTER_RECONNECT_FAILURES && reconnects >= RELOAD_AFTER_RECONNECT_FAILURES;
}

/** 页面内探针脚本（单行；读数经 postMessage 回传，标签 GUARD_MESSAGE_PREFIX）。 */
export function buildGuardProbeScript(timeoutMs: number = GUARD_PROBE_TIMEOUT_MS): string {
  const probe =
    '(function(){'
    + 'var done=false;'
    + 'function out(s){return s+"|"+(navigator.onLine?1:0)+"|"+sock();}'
    + 'function sock(){try{return (performance&&performance.now)?Math.round(performance.now()):"-";}catch(e){return "-";}}'
    + 'return new Promise(function(res){'
    + 'var fin=function(s){if(!done){done=true;res(out(s));}};'
    + `setTimeout(function(){fin("null");},${timeoutMs});`
    + 'try{'
    + 'fetch(location.origin+"/api/remote.mux",{method:"GET",cache:"no-store"})'
    + '.then(function(){fin(globalThis.__DSH_BOOT__?"ds":"ds0");})'
    + '.catch(function(){fin("err");});'
    + '}catch(e){fin("err");}'
    + '});'
    + '})()';
  return '(function(){'
    + `function post(v){try{window.ReactNativeWebView.postMessage("${GUARD_MESSAGE_PREFIX}"+v);}catch(e){}}`
    + 'try{'
    + `Promise.resolve(${probe}).then(function(v){post(String(v));},function(){post("null");});`
    + '}catch(e){post("null");}'
    + 'return true;'
    + '})()';
}

/** 页面内轻量重连脚本（单行）：派发 offline→online 事件对，走 dsh 客户端官方恢复路径。 */
export function buildLightReconnectScript(): string {
  return '(function(){try{'
    + 'var fire=function(t){try{window.dispatchEvent(new Event(t));}catch(e){}};'
    + 'fire("offline");fire("online");'
    + 'return "ok";'
    + '}catch(e){return "err";}})()';
}

/** 从 postMessage 文本里取出探针读数（非本守卫消息返回 null）。 */
export function readingFromMessage(data: unknown): string | null {
  if (typeof data !== 'string' || !data.startsWith(GUARD_MESSAGE_PREFIX)) return null;
  return parseGuardProbeResult(data.slice(GUARD_MESSAGE_PREFIX.length));
}
