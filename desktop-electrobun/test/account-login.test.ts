import { describe, expect, test } from 'bun:test'
import { isOpenableLoginUrl, loginUrlToOpen, platformLoginUrl, readSignInAttempt } from '../src/shared/app/account-login.ts'

const WAITING = {
  status: 'signed-out',
  attempt: {
    id: 'att-1',
    phase: 'waiting-browser',
    authorizeUrl: 'https://platform.deepseek.com/oauth/authorize?client_id=dsh&state=s1',
  },
}

describe('账号登录投影（#169 纯判定层）', () => {
  test('readSignInAttempt 只认 id/phase/authorizeUrl，形状不对当没有', () => {
    expect(readSignInAttempt(WAITING)).toEqual({
      id: 'att-1',
      phase: 'waiting-browser',
      authorizeUrl: 'https://platform.deepseek.com/oauth/authorize?client_id=dsh&state=s1',
    })
    expect(readSignInAttempt({ status: 'signed-out', attempt: null })).toBeNull()
    expect(readSignInAttempt({ attempt: { id: 'x' } })).toBeNull()
    expect(readSignInAttempt({ attempt: { id: '', phase: 'waiting-browser' } })).toBeNull()
    expect(readSignInAttempt(null)).toBeNull()
    expect(readSignInAttempt('signed-out')).toBeNull()
  })

  test('loginUrlToOpen：只在等待浏览器且本 attempt 没开过时给地址', () => {
    expect(loginUrlToOpen(WAITING, '')).toEqual({
      openedAttempt: 'att-1',
      url: 'https://platform.deepseek.com/oauth/authorize?client_id=dsh&state=s1',
    })
    // 同一 attempt 的重复推送不再开窗
    expect(loginUrlToOpen(WAITING, 'att-1')).toEqual({ openedAttempt: 'att-1', url: null })
    // 别的阶段一律不打开，也不消耗去重键
    expect(loginUrlToOpen({ attempt: { id: 'att-2', phase: 'exchanging' } }, 'att-1')).toEqual({ openedAttempt: 'att-1', url: null })
    // 等浏览器但还没有授权地址（请求还没回来）先不打开
    expect(loginUrlToOpen({ attempt: { id: 'att-3', phase: 'waiting-browser' } }, '')).toEqual({ openedAttempt: '', url: null })
    expect(loginUrlToOpen(undefined, '')).toEqual({ openedAttempt: '', url: null })
  })

  test('platformLoginUrl：浅/深色拼 theme，system 交给页面自己', () => {
    const url = platformLoginUrl('https://platform.deepseek.com/oauth/authorize?client_id=dsh&state=s1', 'dark')
    expect(url).toContain('theme=dark')
    expect(url).toContain('client_id=dsh')
    expect(url).toContain('state=s1')
    expect(platformLoginUrl('https://platform.deepseek.com/oauth/authorize?client_id=dsh', 'light')).toContain('theme=light')
    expect(platformLoginUrl('https://platform.deepseek.com/oauth/authorize?client_id=dsh', 'system')).not.toContain('theme=')
  })

  test('isOpenableLoginUrl：https 与 loopback http 才放，凭据/其它协议不放', () => {
    expect(isOpenableLoginUrl('https://platform.deepseek.com/oauth/authorize')).toBe(true)
    expect(isOpenableLoginUrl('http://127.0.0.1:3081/oauth/authorize')).toBe(true)
    expect(isOpenableLoginUrl('http://localhost:3081/oauth/authorize')).toBe(true)
    expect(isOpenableLoginUrl('http://[::1]:3081/oauth/authorize')).toBe(true)
    expect(isOpenableLoginUrl('http://platform.deepseek.com/oauth/authorize')).toBe(false)
    expect(isOpenableLoginUrl('https://user:pass@platform.deepseek.com/oauth')).toBe(false)
    expect(isOpenableLoginUrl('javascript:alert(1)')).toBe(false)
    expect(isOpenableLoginUrl('file:///etc/passwd')).toBe(false)
    expect(isOpenableLoginUrl('not a url')).toBe(false)
  })
})
