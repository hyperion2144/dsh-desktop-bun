// #195：进页面占位地址的判定（纯逻辑锁死）——占位绝不裸连远端。
import { describe, it, expect } from 'vitest';
import { entryPlaceholderUrl } from './remote-entry';

const TARGET = 'http://192.168.3.90:3092/';
const COOKIE = 'dsh_mobile_session=abc123';

describe('#195 进页面占位地址', () => {
  it('配对入口：一律停 about:blank（一次性 token 不能让 webview 消费）', () => {
    expect(
      entryPlaceholderUrl({ entryPath: '/pair?token=x', sessionCookie: COOKIE, targetUrl: `${TARGET}pair?token=x` }),
    ).toBe('about:blank');
    expect(
      entryPlaceholderUrl({ entryPath: '/__dsh-mobile/pair?token=x', sessionCookie: null, targetUrl: `${TARGET}__dsh-mobile/pair?token=x` }),
    ).toBe('about:blank');
  });

  it('cookie 未就绪：停 about:blank（无 cookie 直连 lane = 401 {"error":"unpaired"}，旧仓 #195 指纹）', () => {
    expect(entryPlaceholderUrl({ entryPath: null, sessionCookie: null, targetUrl: TARGET })).toBe('about:blank');
  });

  it('cookie 已知且非入口：占位=真实地址（source 变化触发带 bootstrap 的重载）', () => {
    expect(entryPlaceholderUrl({ entryPath: null, sessionCookie: COOKIE, targetUrl: TARGET })).toBe(TARGET);
  });
});
