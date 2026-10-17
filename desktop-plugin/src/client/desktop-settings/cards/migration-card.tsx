// 「迁移 Profile」卡（#88/#90）：把一个 profile 的目录全量复制到另一个，是当前时点的快照。
//
// 两处结构是刻意写平的，别"顺手简化"：
// ① 进度轮询在 running=false 时**不**停——MIG_RUNNING 在 task_begin 之前会短暂为 false，
//    那是「需确认覆盖」的重试窗口，误杀会让进度条凭空消失（#95 实测过）。
// ② start(overwrite) 递归重试时**不洗** migrationRunning，避免把进度条收起来又弹回去。
import React, { useEffect, useRef, useState } from 'react'
import { PfBtn, SectionBox, showToast } from '../chrome.tsx'
import { LABEL_STYLE, NOTE_STYLE, ROW_STYLE } from '../styles.ts'
import { ThemeSelect } from '../../theme-select.tsx'
import { invoke } from '../rpc.ts'
import type { InitialData } from '../use-initial-data.ts'
import type { MigrationStatus, Notify } from '../types.ts'

export function MigrationCard({
  profiles,
  loaded,
  notify,
}: {
  profiles: Array<{ name: string; active: boolean; selectable: boolean }>
  loaded: InitialData | null
  notify: Notify
}): React.ReactElement {
  const [migrationSource, setMigrationSource] = useState('')
  const [migrationDest, setMigrationDest] = useState('')
  const [migrationRunning, setMigrationRunning] = useState(false)
  const [migrationProgress, setMigrationProgress] = useState<{ copied: number; total: number } | null>(null)

  // 两个 select 的默认值只在壳首次回话时填一次（原代码是挂载 effect 里 fill/fillDst）。
  const selectsFilledRef = useRef(false)
  useEffect(() => {
    if (!loaded || selectsFilledRef.current) return
    selectsFilledRef.current = true
    setMigrationSource(loaded.migrationSource)
    setMigrationDest(loaded.migrationDest)
  }, [loaded])

  // ── 迁移进度轮询：migrationRunning=true 时启动；running=false 后自动结束。──
  useEffect(() => {
    if (!migrationRunning) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const st = await invoke<MigrationStatus>('migration_status')
        if (cancelled) return
        if (st.running) {
          setMigrationProgress({ copied: st.copied, total: st.total })
          window.setTimeout(tick, 300)
        } else {
          // 不主动 setMigrationRunning(false)——MIG_RUNNING 在 task_begin 前短暂为 false
          // （需确认覆盖重试窗口），误杀会导致进度条消失（#95 实测）。
          // 继续轮询等 .finally() 清理。
          window.setTimeout(tick, 300)
        }
      } catch {
        /* 单次失败不终止轮询，等下一次 tick */
      }
    }
    void tick()
    return () => { cancelled = true }
  }, [migrationRunning])

  const handleMigrate = (): void => {
    if (!migrationDest) {
      notify({ ok: false, text: '没有可选的目标 profile（请先新建一个）' })
      return
    }
    // 扁平化结构（同 handleDownloadRuntime 模式）：不用 .finally()、不用递归，
    // 每条路径显式管理 migrationRunning。“需确认覆盖”重试不洗 running 状态。
    const start = (overwrite: boolean): void => {
      setMigrationRunning(true)
      setMigrationProgress({ copied: 0, total: 0 })
      invoke<string>('migrate_profile', { source: migrationSource, dest: migrationDest, overwrite })
        .then((s) => {
          setMigrationRunning(false)
          setMigrationProgress(null)
          showToast(s, true)
        })
        .catch((e) => {
          const m = String(e)
          if (!overwrite && m.includes('需确认覆盖')) {
            // 覆盖确认重试：不洗 running，直接发第二次 invoke
            console.error('[migrate] 需确认覆盖，重试 overwrite=true')
            start(true)
            return
          }
          setMigrationRunning(false)
          setMigrationProgress(null)
          console.error('[migrate] 失败：', m)
          showToast(`迁移失败：${m}`, false)
        })
    }
    start(false)
  }

  // 迁移 select 选项：源 = 全 profile；目标 = 排除源后的其余 profile（原 fillDst 行为）。
  const migrationDestOptions = profiles.filter((p) => p.name !== migrationSource)

  return (
    <SectionBox title="迁移 Profile">
      <div style={LABEL_STYLE}>源 profile → 目标 profile（全量复制；目标已存在需覆盖确认）</div>
      <div style={ROW_STYLE}>
        <ThemeSelect
          style={{ flex: 1 }}
          value={migrationSource}
          onChange={(v) => {
            setMigrationSource(v)
            const others = profiles.filter((p) => p.name !== v)
            const nextDest = others.find((p) => p.name === migrationDest) ?? others[0]
            if (nextDest) setMigrationDest(nextDest.name)
            else setMigrationDest('')
          }}
          options={(profiles ?? []).map((p) => ({ value: p.name, label: p.name }))}
        />
        <ThemeSelect
          style={{ flex: 1 }}
          value={migrationDest}
          onChange={(v) => setMigrationDest(v)}
          options={migrationDestOptions.map((p) => ({ value: p.name, label: p.name }))}
        />
        <PfBtn variant="ghost" onClick={handleMigrate}>迁移…</PfBtn>
      </div>

      {migrationRunning && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              height: 6,
              borderRadius: 4,
              background: 'var(--dsw-alias-bg-base,#111)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width:
                  migrationProgress && migrationProgress.total > 0
                    ? `${Math.min(100, Math.round((migrationProgress.copied / migrationProgress.total) * 100))}%`
                    : '0%',
                background: 'var(--dsw-alias-state-accent-primary,#3b82f6)',
                transition: 'width .2s',
              }}
            />
          </div>
          <div style={NOTE_STYLE}>
            {migrationProgress
              ? `迁移中：${migrationProgress.copied}/${migrationProgress.total} 个文件（${
                  migrationProgress.total > 0
                    ? Math.min(100, Math.round((migrationProgress.copied / migrationProgress.total) * 100))
                    : 0
                }%）`
              : '准备中…'}
          </div>
        </div>
      )}

      <div style={NOTE_STYLE}>
        迁移为当前时点快照：不停止、不重启任何运行中的服务；源在迁移期间的新数据不包含在副本内。目标为激活 profile 时拒绝迁移。
      </div>
    </SectionBox>
  )
}
