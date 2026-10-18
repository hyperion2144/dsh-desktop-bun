import { test, expect } from 'vitest';
import {
  BACKOFF_CAP_MS,
  GUARD_MESSAGE_PREFIX,
  GUARD_PROBE_TIMEOUT_MS,
  actionForReading,
  backoffDelayMs,
  buildGuardProbeScript,
  buildLightReconnectScript,
  parseGuardProbeResult,
  readingFromMessage,
  shouldEscalateToReload,
} from './session-guard';

// 语义源：mobile/shell-web/session-guard.mjs（那份有 node:test 版本）。这里用同一组断言复验，
// 保证 expo 壳的判定与共享逻辑源不漂移。

test('退避：前两次不等待，之后指数增长并封顶', () => {
  expect(backoffDelayMs(0)).toBe(0);
  expect(backoffDelayMs(1)).toBe(0);
  // #175：缺省基数 2s → 10s；第 4 次即封顶 30s。
  expect(backoffDelayMs(2)).toBe(10000);
  expect(backoffDelayMs(3)).toBe(20000);
  expect(backoffDelayMs(4)).toBe(BACKOFF_CAP_MS);
  expect(backoffDelayMs(9)).toBe(BACKOFF_CAP_MS);
  expect(backoffDelayMs(Number.NaN)).toBe(0);
  // 壳下发基数（桌面设置 mobile_guard_backoff_ms）：按传入值算，非法值退回缺省。
  expect(backoffDelayMs(2, 3000)).toBe(3000);
  expect(backoffDelayMs(3, 3000)).toBe(6000);
  expect(backoffDelayMs(2, 0)).toBe(10000);
});

test('探针读数解析：合法形态保留，其余一律 null', () => {
  expect(parseGuardProbeResult('ds|1|12.3')).toBe('ds|1|12.3');
  expect(parseGuardProbeResult('"ds0|0|-"')).toBe('ds0|0|-');
  expect(parseGuardProbeResult('err|1|88')).toBe('err|1|88');
  expect(parseGuardProbeResult('ds|2|-')).toBeNull();
  expect(parseGuardProbeResult('ready|1|-')).toBeNull();
  expect(parseGuardProbeResult('')).toBeNull();
  expect(parseGuardProbeResult(null)).toBeNull();
});

test('判定表：健康不动手、掉线轻量重连、无网等网络、读不到一律不动（重载只留给渲染崩溃）', () => {
  expect(actionForReading('ds|1|12')).toBe('none');
  expect(actionForReading('ds0|1|12')).toBe('reconnect');
  expect(actionForReading('err|1|-')).toBe('reconnect');
  expect(actionForReading('off|0|-')).toBe('wait-network');
  // 2026-10-18 修订：页面回了 null（探测请求超时，弱网常态）不再轻量重连 → 避免部分内容重刷
  expect(actionForReading('null|1|-')).toBe('none');
  expect(actionForReading(null)).toBe('none');
  expect(actionForReading('ds')).toBe('none');
});

test('升级为兜底重载：只有连续多次轻量重连仍失败才升级', () => {
  expect(shouldEscalateToReload(1, 1)).toBe(false);
  expect(shouldEscalateToReload(3, 2)).toBe(false);
  expect(shouldEscalateToReload(3, 3)).toBe(true);
});

test('探针脚本：单行、postMessage 回传、走 mux 端点、带超时', () => {
  const s = buildGuardProbeScript();
  expect(s.includes('\n')).toBe(false);
  expect(s).toContain('ReactNativeWebView.postMessage');
  expect(s).toContain('/api/remote.mux');
  expect(s).toContain('__DSH_BOOT__');
  expect(s).toContain(String(GUARD_PROBE_TIMEOUT_MS));
});

test('轻量重连脚本：offline→online 事件对，绝不整页重载', () => {
  const s = buildLightReconnectScript();
  expect(s.includes('\n')).toBe(false);
  expect(s).toContain('dispatchEvent');
  expect(s).toContain('"offline"');
  expect(s).toContain('"online"');
  expect(s).not.toContain('location.reload');
});

test('postMessage 读数提取：只认本守卫标签', () => {
  expect(readingFromMessage(GUARD_MESSAGE_PREFIX + 'ds|1|9')).toBe('ds|1|9');
  expect(readingFromMessage('别的消息')).toBeNull();
  expect(readingFromMessage(GUARD_MESSAGE_PREFIX + 'garbage')).toBeNull();
  expect(readingFromMessage(123)).toBeNull();
});
