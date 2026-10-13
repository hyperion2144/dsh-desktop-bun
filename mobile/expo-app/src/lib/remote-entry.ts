// WebScreen 用得上的两个小工具（#155）：入口路径判定与空状态。
//
// 单独成模块的理由：WebScreen 只该管渲染；这两个判断（"这个地址是不是一次性配对入口"、
// "浮层的初始状态长什么样"）是纯逻辑，放在这里能被 tsc 与未来的测试直接覆盖。
import type { SessionState } from './remote-controller';

/** 空状态（浮层在"端口构建失败"这类场景下需要一个完整状态对象）。 */
export const emptyState: SessionState = {
  phase: 'idle',
  url: null,
  gate: null,
  reason: null,
  version: null,
  entry: null,
  logs: [],
};

/** 配对入口的路径形态（与 `shell-web` 的冻结别名一致：`/pair` 与 `/__dsh-mobile/pair`）。 */
const PAIR_PATHS = ['/pair', '/__dsh-mobile/pair'];

/**
 * 从完整地址里取出「一次性入口路径」（`/pair?token=…`）：
 * - 是配对入口（含冻结别名）→ 返回 `pathname + search`，交给编排去换会话 cookie；
 * - 带 `token` 查询参数的其它地址（dsh 的 `/?token=…`）→ 也算入口；
 * - 普通地址 → null（只做版本检测，不去消费任何一次性凭据）。
 */
export function entryPathOf(url: string): string | null {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    if (PAIR_PATHS.includes(path)) return `${path}${u.search}`;
    if (u.searchParams.get('token')) return `${path}${u.search}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * #195：进页面的占位地址——**绝不裸连远端**。
 *
 * 配对入口是一次性凭据（webview 一加载就消费掉，壳随后换会话必失败）；会话 cookie 未就绪
 * （ports 还在异步构建）时直连远端 = 无 cookie 打 lane 门禁，拿到的正是 401 `{"error":"unpaired"}`。
 * 而三选一的 fallback URL 与占位相同——source 不变不触发重载，`injectedJavaScriptBeforeContentLoaded`
 * 的 cookie bootstrap 永远补不上，页面就停在 unpair。所以这两种情形都停 about:blank，等
 * source 变化（cookie 已知 / fallback 地址）时自然重载、bootstrap 随导航注入。（鸿蒙侧 #155
 * 同一教训：`一律先从 about:blank 开始`，导航统一 controller.loadUrl。）
 */
export function entryPlaceholderUrl(opts: {
  entryPath: string | null;
  sessionCookie: string | null;
  targetUrl: string;
}): string {
  if (opts.entryPath !== null) return 'about:blank';
  if (opts.sessionCookie === null) return 'about:blank';
  return opts.targetUrl;
}
