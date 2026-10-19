// loopback 数据面的 GET 单飞（#54）：同一时刻同一 URL 的并发 GET 只让一个打上游，其余搭车等它的结果。
//
// 这条线的三个判别量（档位字符串、派生的「是否合并」、在飞表里有没有领头）原本摊在
// shell-server.ts 的 proxy() 里五处，读一遍要同时维护三个量才推得出走哪条路。
// #144-3 把它们收成一处：一个穷尽的档位策略表 + 一个在飞登记表，转发流程只读导出的结果。
//
// 边界（架构口径，#54 拍板）：**只合并还没发出去的请求**。跟随者等满上限后自己再发一次是安全的
// ——它那个请求从头到尾没到过上游；反过来，绝不给任何已发出的请求加自动重试：壳侧 handler
// 没有取消语义，重发会让副作用翻倍。所以这里没有任何 retry。

import type { LoopbackAggregation } from '../../shared/settings/settings.ts'

/**
 * 跟随者等待领头落地的上限（#144-1），毫秒。
 *
 * 为什么必须有：共享结果只在「领头整条 body 读完 / 失败 / 判定不可共享」时 settle。
 * 领头一旦卡住不落地，所有搭车请求就无限期挂住——页面永远转圈，壳侧在飞计数与连接一直占着，
 * 客户端 abort 也不摘表，只能重启壳才恢复。
 *
 * 实机要调阈值不必重新打包：ShellServerOptions.followerWaitMs 是 live getter
 * 注意：`ShellServerOptions.followerWaitMs` 这个口**service.ts 目前没有传**，
 * 也就是壳里生效的值就是上面的 10s 常量——没有对应的设置键，写「实机改阈值」是假的。
 * 留这个口有两个真实用途：测试要注入 150ms 这种小阈值（10s 的超时路径没法进单测），
 * 以及将来真把它做成设置项时不必改壳的读法。真要暴露成设置，请连着 service.ts 一起改。
 *
 */
export const FOLLOWER_WAIT_MS = 10_000

/**
 * 档位策略（#128 的三档）：一个档位 = 一条确定的数据面转发路线。
 *
 * 转发流程只 switch 这个判别标签，不再比较档位字符串，也不再持有派生的「是否合并」布尔量。
 */
export type AggregationPolicy =
  /** full（缺省，#54 原行为）：合并并发 GET，整条缓冲（≤256KB）后才下发。 */
  | { readonly kind: 'coalesced-buffered' }
  /** stream（#128）：合并并发 GET，但领头边到边下发（首字节不等整条），旁路累积一份给跟随者。 */
  | { readonly kind: 'coalesced-streamed' }
  /** none：压根不搭车，每个 GET 各自打上游（health 的 coalesced 恒为 0）。 */
  | { readonly kind: 'passthrough' }

/**
 * 穷尽映射：键就是 LoopbackAggregation 的全集。给枚举加一个档位值，这里立刻编译报错，
 * 而不是让转发流程静默走某条默认路线。
 */
export const AGGREGATION_POLICIES: { readonly [K in LoopbackAggregation]: AggregationPolicy } = {
  full: { kind: 'coalesced-buffered' },
  stream: { kind: 'coalesced-streamed' },
  none: { kind: 'passthrough' },
}

/** 取某一档的转发策略。 */
export function aggregationPolicy(mode: LoopbackAggregation): AggregationPolicy {
  return AGGREGATION_POLICIES[mode]
}

/** 单飞共享的已完成响应：`full` 档是整条缓冲，`stream` 档是转发过程中旁路累积的那一份。 */
export interface SharedGet {
  status: number
  headers: Headers
  body: ArrayBuffer
}

/** 在飞中的领头 GET：等待者搭车拿 SharedGet；done 之后不再有人搭车。 */
export interface InflightGet {
  done: boolean
  buffered: Promise<SharedGet | null>
  resolve: (value: SharedGet | null) => void
}

/** 跟随者一次等待的终点：四条里恰好命中一条。 */
export type FollowerWait =
  /** 领头落了可共享的响应，直接整条返回。 */
  | { readonly kind: 'shared'; readonly shared: SharedGet }
  /** 领头失败或判定不可共享（超 256KB / 无 body）：跟 #54 一样，落回自己打一次上游。 */
  | { readonly kind: 'unshared' }
  /** 等满上限而掉队：自己打一次——这个请求还没发出去过，重发没有副作用。 */
  | { readonly kind: 'timeout' }
  /** 页面自己断了：不再占资源，也不该替它去打上游。 */
  | { readonly kind: 'aborted' }

/**
 * 在飞登记表（每个服务面一个）。
 *
 * 只做三件事：登记领头、结算领头、等领头。不碰 fetch，因此这里不存在任何「重发已发出请求」的路径。
 */
export class GetCoalescer {
  private readonly inflight = new Map<string, InflightGet>()
  private joinedCount = 0
  private dropoutCount = 0

  /** 搭上车的跟随者数（health 的 coalesced）。其中超时掉队的另计 followerDropouts。 */
  get joined(): number {
    return this.joinedCount
  }

  /** 因等满上限而掉队的跟随者数（health 的 followerDropouts）——「上游卡住」的实机信号。 */
  get dropouts(): number {
    return this.dropoutCount
  }

  /** 当前登记着的领头数（自检用：正常空闲时为 0）。 */
  get pending(): number {
    return this.inflight.size
  }

  /** 在飞的领头（没有则 undefined）。只看不登记。 */
  peek(key: string): InflightGet | undefined {
    return this.inflight.get(key)
  }

  /**
   * 领头占位：先登记再发上游，并发同 URL 才赶得上搭车。
   * 已有活着的领头时不重复登记（返回 null）——这个请求就只是自己打一次。
   */
  claim(key: string): InflightGet | null {
    const prior = this.inflight.get(key)
    if (prior !== undefined && prior.done) this.inflight.delete(key)
    if (this.inflight.has(key)) return null
    let resolve!: (value: SharedGet | null) => void
    const buffered = new Promise<SharedGet | null>((res) => {
      resolve = res
    })
    const entry: InflightGet = { done: false, buffered, resolve }
    this.inflight.set(key, entry)
    return entry
  }

  /**
   * 领头结算（恰好一次）：settle 共享结果 + 立刻摘表，后到的跟随者不再搭车。
   * entry 为 null = 这个请求没登记过（没搭车闸），什么都不做。
   */
  settle(key: string, entry: InflightGet | null, value: SharedGet | null): void {
    if (entry === null) return
    entry.done = true
    entry.resolve(value)
    if (this.inflight.get(key) === entry) this.inflight.delete(key)
  }

  /**
   * 跟随者等待（#144-1）。三条终点（领头结算 / 等满上限 / 页面 abort）恰好一条生效，
   * 且定时器与 abort 监听器在返回前一定清掉——不泄漏。
   *
   * 调用方拿到 { kind: 'unshared' | 'timeout' } 时自己打一次上游，拿到 { kind: 'aborted' } 时直接放弃。
   */
  async wait(entry: InflightGet, signal: AbortSignal, waitMs: number): Promise<FollowerWait> {
    if (signal.aborted) return { kind: 'aborted' }
    this.joinedCount += 1
    return new Promise<FollowerWait>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: FollowerWait): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => {
        finish({ kind: 'aborted' })
      }
      timer = setTimeout(() => {
        this.dropoutCount += 1
        finish({ kind: 'timeout' })
      }, waitMs)
      signal.addEventListener('abort', onAbort, { once: true })
      void entry.buffered.then((shared) => {
        finish(shared === null ? { kind: 'unshared' } : { kind: 'shared', shared })
      })
    })
  }
}
