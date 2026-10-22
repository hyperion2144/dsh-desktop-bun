// profile 注册表（map #240 / #242）。
//
// #240-⑥：profile 列表 = 本地 + 远程统一条目。守护是权威记账方：托盘（#241）、
// 壳（#243）、页面（#244）都从这里读「现在有哪些 profile、各自什么状态」。
//
// 持久化：appSupport/daemon-profiles.json，tmp+rename 原子写（与 restart/intent.ts
// 同一口径）。IO 全部可注入，单测不碰磁盘；实现里宽容读（坏文件按空表继续）。

import { join } from 'node:path'

/** 注册表文件名（appSupport 下）。 */
export const DAEMON_PROFILES_FILENAME = 'daemon-profiles.json'

export type ProfileKind = 'local' | 'remote'

/** 统一条目状态：远程条目只有 stopped/running 两种（跑没跑由远端说了算）。 */
export type ProfileStatus = 'stopped' | 'starting' | 'running' | 'crashed'

export interface ProfileEntry {
  /** 稳定 id：本地 = profile 名；远程 = `remote:<host>:<port>` 归一化串 */
  id: string
  kind: ProfileKind
  /** 展示名（本地默认 = profile 名；远程 = 用户起的别名或 host:port） */
  name: string
  /** 运行态（内存权威；持久化里保留上次已知值，重启后按 shell 锁/心跳修正） */
  status: ProfileStatus
  /** 本地条目：壳进程 pid（跑着才有） */
  pid: number | null
  /** 远程条目：服务地址（本地条目恒 null） */
  remoteUrl: string | null
  startedAt: string | null
}

/** 注入式 IO：默认实现走 node:fs，测试塞内存 map。 */
export interface RegistryIo {
  readFile: (path: string) => string | null
  writeFile: (path: string, text: string) => void
}

export function defaultRegistryIo(): RegistryIo {
  // 延迟 import 不必要——node:fs 在 bun 主进程是零成本内置。
  const fs = require('node:fs') as typeof import('node:fs')
  return {
    readFile: (path) => {
      try {
        return fs.readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: (path, text) => {
      fs.mkdirSync(join(path, '..'), { recursive: true })
      const tmp = `${path}.tmp-${String(process.pid)}`
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, path)
    },
  }
}

export interface PersistedRegistry {
  version: 1
  entries: ProfileEntry[]
}

/** 宽容读：文件缺失/损坏/字段不合法 → 空表。 */
export function parseRegistry(text: string | null): PersistedRegistry {
  const empty: PersistedRegistry = { version: 1, entries: [] }
  if (text === null || text.trim() === '') return empty
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return empty
    const raw = parsed as { version?: unknown; entries?: unknown }
    if (!Array.isArray(raw.entries)) return empty
    const entries: ProfileEntry[] = []
    for (const item of raw.entries) {
      const entry = coerceEntry(item)
      if (entry !== null) entries.push(entry)
    }
    return { version: 1, entries }
  } catch {
    return empty
  }
}

function coerceEntry(item: unknown): ProfileEntry | null {
  if (typeof item !== 'object' || item === null) return null
  const raw = item as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id === '') return null
  if (raw.kind !== 'local' && raw.kind !== 'remote') return null
  return {
    id: raw.id,
    kind: raw.kind,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
    status: coerceStatus(raw.status),
    pid: typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null,
    remoteUrl: typeof raw.remoteUrl === 'string' && raw.remoteUrl !== '' ? raw.remoteUrl : null,
    startedAt: typeof raw.startedAt === 'string' && raw.startedAt !== '' ? raw.startedAt : null,
  }
}

function coerceStatus(value: unknown): ProfileStatus {
  return value === 'starting' || value === 'running' || value === 'crashed' ? value : 'stopped'
}

/** 远程条目 id 归一：去尾斜杠、host:port 小写——同一地址不因书写差异重复登记。 */
export function remoteProfileId(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\/+$/, '')
  return `remote:${trimmed.toLowerCase()}`
}

export class ProfileRegistry {
  private entries = new Map<string, ProfileEntry>()
  readonly path: string
  private readonly io: RegistryIo

  constructor(appSupport: string, io: RegistryIo = defaultRegistryIo()) {
    this.path = join(appSupport, DAEMON_PROFILES_FILENAME)
    this.io = io
    for (const entry of parseRegistry(io.readFile(this.path)).entries) {
      // 重启后内存态从「上次已知」改为 stopped：pid 是上一个世界的，心跳会把它改回来。
      entry.status = entry.kind === 'remote' ? entry.status : 'stopped'
      entry.pid = entry.kind === 'local' ? null : entry.pid
      this.entries.set(entry.id, entry)
    }
  }

  list(): ProfileEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): ProfileEntry | null {
    return this.entries.get(id) ?? null
  }

  /** 登记或更新本地条目（幂等：同 id 只有一条）。 */
  upsertLocal(profile: string): ProfileEntry {
    const entry: ProfileEntry = {
      id: profile,
      kind: 'local',
      name: profile,
      status: this.entries.get(profile)?.status ?? 'stopped',
      pid: this.entries.get(profile)?.pid ?? null,
      remoteUrl: null,
      startedAt: this.entries.get(profile)?.startedAt ?? null,
    }
    this.entries.set(entry.id, entry)
    this.persist()
    return entry
  }

  /** 登记或更新远程条目（同地址幂等；name 变更即改名）。 */
  upsertRemote(remoteUrl: string, name?: string): ProfileEntry {
    const id = remoteProfileId(remoteUrl)
    const existing = this.entries.get(id)
    const entry: ProfileEntry = {
      id,
      kind: 'remote',
      name: name ?? existing?.name ?? remoteUrl.replace(/^https?:\/\//, ''),
      status: existing?.status ?? 'stopped',
      pid: null,
      remoteUrl,
      startedAt: existing?.startedAt ?? null,
    }
    this.entries.set(id, entry)
    this.persist()
    return entry
  }

  remove(id: string): boolean {
    const existed = this.entries.delete(id)
    if (existed) this.persist()
    return existed
  }

  markStatus(id: string, status: ProfileStatus, pid: number | null = null): ProfileEntry | null {
    const entry = this.entries.get(id)
    if (entry === undefined) return null
    entry.status = status
    if (entry.kind === 'local') entry.pid = status === 'stopped' || status === 'crashed' ? null : pid
    if (status === 'running') entry.startedAt = new Date().toISOString()
    this.persist()
    return entry
  }

  private persist(): void {
    const payload: PersistedRegistry = { version: 1, entries: this.list() }
    this.io.writeFile(this.path, `${JSON.stringify(payload, null, 2)}\n`)
  }
}
