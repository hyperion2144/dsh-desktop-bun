// #237 统一后台运行模型：重启意图文件与监督进程租约的落盘契约。
//
// 壳（桌面进程）与监督进程（runtime/shell-supervisor.mjs）不共享进程、不共享端口，
// 两个文件就是它们之间唯一的对话方式，都住在 appSupportDir() 下：
//   · shell-restart.request  桌面 → 监督进程：「我这次退出是要重启，替我拉起下一个」。
//   · shell-supervisor.json  监督进程的租约：谁在监督、此刻守的是哪个桌面。桌面冷启动
//     用它判断要不要自举新的监督进程；监督进程收尾时只清**自己 bootId** 的租约
//     （接任者会覆写租约，无脑删文件会把别人的租约一起带走）。
//
// 读一律宽容：缺文件 / 坏 JSON / 字段非法都返回 null——监督进程不能被一份脏文件卡死。
// 写一律 tmp+rename 原子落盘，避免对面读到半截 JSON。

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 重启意图文件名（appSupportDir() 下）。 */
export const RESTART_REQUEST_FILENAME = 'shell-restart.request'

/** 监督进程租约文件名（appSupportDir() 下）。 */
export const SUPERVISOR_LEASE_FILENAME = 'shell-supervisor.json'

/** 重启意图：pid = 写下这份意图的桌面进程，at = 写入时刻（ISO 8601，取证用）。 */
export type RestartIntent = { pid: number; at: string }

/**
 * 监督进程租约。supervisorPid = 监督进程自己；desktopPid = 它此刻在守的桌面；
 * bootId = 这份租约的身证（收尾只清自己 bootId 的，见 clearSupervisorLease）。
 */
export type SupervisorLease = {
  supervisorPid: number
  desktopPid: number
  bootId: string
  startedAt: string
}

/** 桌面单实例台账（single-instance.ts 维护）；监督进程轮询它认领「下一个桌面已接位」。 */
export function instanceFilePath(appSupport: string): string {
  return join(appSupport, 'shell-instance.json')
}

export function intentFilePath(appSupport: string): string {
  return join(appSupport, RESTART_REQUEST_FILENAME)
}

export function supervisorLeasePath(appSupport: string): string {
  return join(appSupport, SUPERVISOR_LEASE_FILENAME)
}

/** 文件 IO 注入口：桌面侧、监督进程与测试同用这一层（缺省 = node:fs 直通）。 */
export type RestartFileIo = {
  exists?: (path: string) => boolean
  readFile?: (path: string) => string
  writeAtomic?: (path: string, text: string) => void
  unlink?: (path: string) => void
}

const defaultIo: Required<RestartFileIo> = {
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  writeAtomic: (path, text) => {
    const tmp = `${path}.tmp-${String(process.pid)}`
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  },
  unlink: (path) => rmSync(path, { force: true }),
}

function ioOf(io?: RestartFileIo): Required<RestartFileIo> {
  return { ...defaultIo, ...io }
}

/** 读重启意图；缺文件 / 坏 JSON / pid 非法都返回 null（宽容读，监督进程不被脏文件卡死）。 */
export function readRestartIntent(file: string, io?: RestartFileIo): RestartIntent | null {
  const io2 = ioOf(io)
  try {
    if (!io2.exists(file)) return null
    const raw = JSON.parse(io2.readFile(file)) as Partial<RestartIntent> | null
    if (raw === null || typeof raw !== 'object') return null
    const pid = raw.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return null
    return { pid, at: typeof raw.at === 'string' ? raw.at : '' }
  } catch {
    return null
  }
}

/** 原子写重启意图。 */
export function writeRestartIntent(file: string, intent: RestartIntent, io?: RestartFileIo): void {
  ioOf(io).writeAtomic(file, `${JSON.stringify(intent, null, 2)}\n`)
}

/** 清掉重启意图（文件不存在不算错）。 */
export function clearRestartIntent(file: string, io?: RestartFileIo): void {
  ioOf(io).unlink(file)
}

/** 读监督进程租约；宽容读同 readRestartIntent。 */
export function readSupervisorLease(file: string, io?: RestartFileIo): SupervisorLease | null {
  const io2 = ioOf(io)
  try {
    if (!io2.exists(file)) return null
    const raw = JSON.parse(io2.readFile(file)) as Partial<SupervisorLease> | null
    if (raw === null || typeof raw !== 'object') return null
    const supervisorPid = raw.supervisorPid
    const desktopPid = raw.desktopPid
    if (typeof supervisorPid !== 'number' || !Number.isInteger(supervisorPid) || supervisorPid <= 1) return null
    if (typeof desktopPid !== 'number' || !Number.isInteger(desktopPid) || desktopPid <= 1) return null
    return {
      supervisorPid,
      desktopPid,
      bootId: typeof raw.bootId === 'string' ? raw.bootId : '',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    }
  } catch {
    return null
  }
}

/** 原子写监督进程租约（监督进程启动时与每次换桌面接位时刷新）。 */
export function writeSupervisorLease(file: string, lease: SupervisorLease, io?: RestartFileIo): void {
  ioOf(io).writeAtomic(file, `${JSON.stringify(lease, null, 2)}\n`)
}

/**
 * 清监督进程租约——只清**自己 bootId** 的那份。监督进程崩溃后接任者会覆写租约，
 * 老进程收尾时若还赖在收尾路上，无脑删文件会把接任者的租约一起带走（双监督互踩）。
 */
export function clearSupervisorLease(file: string, bootId: string, io?: RestartFileIo): void {
  const lease = readSupervisorLease(file, io)
  if (lease === null) return
  if (lease.bootId !== bootId) return
  ioOf(io).unlink(file)
}
