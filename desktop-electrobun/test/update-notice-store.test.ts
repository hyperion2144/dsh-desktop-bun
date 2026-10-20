// #142 update-notice.json 的落盘口径：原子写、抗残文件、拉黑带路、记账只往高处。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createUpdateNoticeStore,
  DEFAULT_UPDATE_NOTICE_STATE,
  parseUpdateNoticeState,
  readUpdateNoticeState,
  updateNoticePath,
  UPDATE_NOTICE_FILE,
  writeUpdateNoticeState,
} from '../src/bun/commands/update-notice-store.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-update-notice-'))
}

describe('parseUpdateNoticeState：抗残文件', () => {
  test('空文件 / null ⇒ 默认值（enabled 默认开）', () => {
    expect(parseUpdateNoticeState(null)).toEqual(DEFAULT_UPDATE_NOTICE_STATE)
    expect(parseUpdateNoticeState('   ')).toEqual(DEFAULT_UPDATE_NOTICE_STATE)
  })

  test('半截 JSON ⇒ 默认值，不抛', () => {
    expect(parseUpdateNoticeState('{"enabled": tru')).toEqual(DEFAULT_UPDATE_NOTICE_STATE)
  })

  test('不是对象（数组 / 字符串 / 数字）⇒ 默认值', () => {
    expect(parseUpdateNoticeState('[1,2]')).toEqual(DEFAULT_UPDATE_NOTICE_STATE)
    expect(parseUpdateNoticeState('"x"')).toEqual(DEFAULT_UPDATE_NOTICE_STATE)
    expect(parseUpdateNoticeState('7')).toEqual(DEFAULT_UPDATE_NOTICE_STATE)
  })

  test('字段类型不对时只丢那一项，不整份当废', () => {
    const state = parseUpdateNoticeState('{"enabled": false, "ignored": "nope", "lastNotified": {"shell": 3, "runtime": "0.2.2-alpha.1"}}')
    expect(state.enabled).toBe(false)
    expect(state.ignored).toEqual([])
    expect(state.lastNotified).toEqual({ shell: null, runtime: '0.2.2-alpha.1' })
  })

  test('ignored 去重去空白；enabled 只认显式 false', () => {
    const state = parseUpdateNoticeState('{"enabled": "false", "ignored": ["shell:0.3.0", " shell:0.3.0 ", "", "  "]}')
    expect(state.enabled).toBe(true)
    expect(state.ignored).toEqual(['shell:0.3.0'])
  })
})

describe('update-notice.json：落盘', () => {
  test('写出去的文件名就是 update-notice.json（不碰 desktop-settings.json）', () => {
    const dir = tempDir()
    try {
      writeUpdateNoticeState(dir, DEFAULT_UPDATE_NOTICE_STATE)
      expect(existsSync(join(dir, UPDATE_NOTICE_FILE))).toBe(true)
      expect(updateNoticePath(dir)).toBe(join(dir, UPDATE_NOTICE_FILE))
      // 原子写的中间产物不该留下
      expect(existsSync(`${updateNoticePath(dir)}.tmp`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('读不到就用默认值（首启不炸）', () => {
    const dir = tempDir()
    try {
      expect(readUpdateNoticeState(dir)).toEqual(DEFAULT_UPDATE_NOTICE_STATE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('写坏了的磁盘状态：读回默认值而不是崩', () => {
    const dir = tempDir()
    try {
      writeFileSync(updateNoticePath(dir), 'not json at all')
      expect(readUpdateNoticeState(dir)).toEqual(DEFAULT_UPDATE_NOTICE_STATE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('默认状态是副本：改读回来的对象不会污染默认值', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.ignore([{ kind: 'shell', version: '0.3.0' }])
      expect(DEFAULT_UPDATE_NOTICE_STATE.ignored).toEqual([])
      expect(readUpdateNoticeState(dir).ignored).toEqual(['shell:0.3.0'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createUpdateNoticeStore：拉黑与记账', () => {
  test('拉黑带路前缀，同号壳与运行时互不相连', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.ignore([
        { kind: 'runtime', version: '0.3.0' },
        { kind: 'shell', version: '0.3.0' },
        { kind: 'shell', version: '0.3.0' },
      ])
      expect(readUpdateNoticeState(dir).ignored).toEqual(['runtime:0.3.0', 'shell:0.3.0'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('记账只往高处记：回落到更低的版本不覆盖', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.markNotified([{ kind: 'shell', version: '0.3.0' }])
      store.markNotified([{ kind: 'shell', version: '0.2.9' }])
      expect(readUpdateNoticeState(dir).lastNotified.shell).toBe('0.3.0')
      store.markNotified([{ kind: 'shell', version: '0.3.1' }])
      expect(readUpdateNoticeState(dir).lastNotified.shell).toBe('0.3.1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('记账分两路：壳的版本号不会写进运行时那一路', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.markNotified([{ kind: 'shell', version: '0.3.0' }, { kind: 'runtime', version: '0.2.2-alpha.1' }])
      expect(readUpdateNoticeState(dir).lastNotified).toEqual({ shell: '0.3.0', runtime: '0.2.2-alpha.1' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('空版本号不记账也不拉黑（别把空串写进文件）', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.markNotified([{ kind: 'shell', version: '' }])
      store.ignore([{ kind: 'shell', version: '' }])
      const raw = readFileSync(updateNoticePath(dir), 'utf8')
      expect(raw).not.toContain('": ""')
      expect(readUpdateNoticeState(dir)).toEqual(DEFAULT_UPDATE_NOTICE_STATE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('setEnabled 落盘，重复写不丢既有拉黑与记账', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.ignore([{ kind: 'shell', version: '0.3.0' }])
      store.markNotified([{ kind: 'runtime', version: '0.2.2-alpha.1' }])
      expect(store.setEnabled(false).enabled).toBe(false)
      const state = readUpdateNoticeState(dir)
      expect(state.enabled).toBe(false)
      expect(state.ignored).toEqual(['shell:0.3.0'])
      expect(state.lastNotified.runtime).toBe('0.2.2-alpha.1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('写盘失败只丢这次记账：如实返回、记日志，不把异常抛给调用方', () => {
    const dir = tempDir()
    try {
      // appSupport 指到一个「文件/子目录」上 ⇒ mkdirSync 与 rename 都会失败，模拟磁盘不可写。
      writeFileSync(join(dir, 'blocker'), 'x')
      const logs: string[] = []
      const store = createUpdateNoticeStore(join(dir, 'blocker', 'app-support'), (line) => logs.push(line))
      const state = store.markNotified([{ kind: 'shell', version: '0.3.0' }])
      // 记账结果照样返回（下次启动会再提醒一次），但失败进了日志而不是消失了。
      expect(state.lastNotified.shell).toBe('0.3.0')
      expect(logs.join('\n')).toContain(UPDATE_NOTICE_FILE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// #136：设置面板的「恢复」与「清空全部」——拉黑表是持久状态，改它必须可逆。
describe('UpdateNoticeStore.restore / clearIgnored（#136 面板的恢复与清空）', () => {
  test('restore 只摘掉指定的那几路，同号的另一路不受影响', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.ignore([{ kind: 'shell', version: '0.3.0' }, { kind: 'runtime', version: '0.3.0' }])
      const after = store.restore([{ kind: 'shell', version: '0.3.0' }])
      expect(after.ignored).toEqual(['runtime:0.3.0'])
      expect(readUpdateNoticeState(dir).ignored).toEqual(['runtime:0.3.0'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('restore 不在列表里是幂等 no-op（面板重复点击不该报错）', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.ignore([{ kind: 'shell', version: '0.3.0' }])
      const after = store.restore([{ kind: 'runtime', version: '9.9.9' }])
      expect(after.ignored).toEqual(['shell:0.3.0'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('空 targets 不写盘（少一次文件改动，也少一次并发覆盖的机会）', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.ignore([{ kind: 'shell', version: '0.3.0' }])
      const before = readFileSync(updateNoticePath(dir), 'utf8')
      expect(store.restore([]).ignored).toEqual(['shell:0.3.0'])
      expect(readFileSync(updateNoticePath(dir), 'utf8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('clearIgnored 清空全部但保留 enabled 与记账', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.ignore([{ kind: 'shell', version: '0.3.0' }, { kind: 'runtime', version: '0.2.2' }])
      store.markNotified([{ kind: 'runtime', version: '0.2.2' }])
      store.setEnabled(false)
      const after = store.clearIgnored()
      expect(after.ignored).toEqual([])
      expect(after.enabled).toBe(false)
      // 记账不清：清掉拉黑不等于「已经提醒过」，清完该弹还得弹。
      expect(after.lastNotified.runtime).toBe('0.2.2')
      expect(readUpdateNoticeState(dir).ignored).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('已经空了就不写盘', () => {
    const dir = tempDir()
    try {
      const store = createUpdateNoticeStore(dir)
      store.read()
      expect(existsSync(updateNoticePath(dir))).toBe(false)
      store.clearIgnored()
      expect(existsSync(updateNoticePath(dir))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
