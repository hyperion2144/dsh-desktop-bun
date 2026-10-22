// 守护进程角色锁（map #240 / #242）。
//
// #242：单实例锁按角色拆分——守护一把（daemon-instance.json）、壳一把（沿用旧
// shell-instance.json，契约不动）。两把锁共用 single-instance.ts 的 acquire/release
// 机械，但语义各管各的角色：守护活着不代表壳活着，壳重启也不影响守护。
//
// 旧锁「迁移」的语义在这里：守护启动时**兼容读**旧壳锁（认领还活着的壳进注册表），
// 而不是把文件搬走——壳锁仍是壳的，守护锁是守护的。

import { join } from 'node:path'
import {
  acquireInstance,
  defaultIsAlive,
  defaultIsOurProcess,
  readInstance,
  releaseInstance,
  type AcquireResult,
  type InstanceRecord,
} from '../platform/single-instance.ts'

/** 守护角色在锁文件里用的 profile 标记（不会与真实 profile 名冲突的保留字）。 */
export const DAEMON_ROLE = '__daemon__'

/** 守护锁文件名（与壳的 shell-instance.json 同目录、不同文件）。 */
export const DAEMON_INSTANCE_FILENAME = 'daemon-instance.json'

export function daemonInstanceFile(appSupport: string): string {
  return join(appSupport, DAEMON_INSTANCE_FILENAME)
}

export function shellInstanceFile(appSupport: string): string {
  return join(appSupport, 'shell-instance.json')
}

export interface AcquireDaemonRoleOptions {
  isAlive?: (pid: number) => boolean
  isOurProcess?: (pid: number, expectedExe?: string) => boolean
  bootId?: string
  identity?: { pid?: number; startedAt?: string; exePath?: string }
}

/**
 * 抢守护角色位。已有守护活着 ⇒ acquired=false（第二个守护让位退出——这是
 * 「应用只有一个守护」的保证点；壳可以多代，守护同时最多一个）。
 */
export function acquireDaemonRole(file: string, options: AcquireDaemonRoleOptions = {}): AcquireResult {
  return acquireInstance(file, DAEMON_ROLE, {
    isAlive: options.isAlive ?? defaultIsAlive,
    isOurProcess: options.isOurProcess ?? defaultIsOurProcess,
    bootId: options.bootId,
    identity: {
      pid: options.identity?.pid,
      startedAt: options.identity?.startedAt,
      exePath: options.identity?.exePath,
    },
  })
}

export function releaseDaemonRole(file: string, pid: number): void {
  releaseInstance(file, pid)
}

/** 读守护锁（兼容 parseInstanceRecord 的容错语义）。 */
export function readDaemonInstance(file: string): InstanceRecord | null {
  return readInstance(file)
}

/**
 * 兼容读旧壳锁：返回记录或 null。守护用答案判断「有没有活着的壳要认领」，
 * 以及重启场景下要不要等它退（与 #237 接班等待同一套 isAlive 口径）。
 */
export function readShellInstance(appSupport: string): InstanceRecord | null {
  return readInstance(shellInstanceFile(appSupport))
}
