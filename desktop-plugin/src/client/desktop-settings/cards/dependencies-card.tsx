// 「依赖状态（pnpm store 一致性）」卡：#122。
// 挂载读一次，重建期间自己转圈；错误必须落到 UI（不许吞成「仅桌面壳可用」）。
import React, { useCallback, useEffect, useState } from 'react'
import { PfBtn, SectionBox } from '../chrome.tsx'
import { LABEL_STYLE, NOTE_STYLE } from '../styles.ts'
import { invoke } from '../rpc.ts'

interface DepProfile {
  profile: string
  recordedPnpm: string | null
  builtinPnpm: string | null
  needsRebuild: boolean
  running: boolean
}

export function DependenciesCard(): React.ReactElement {
  const [depProfiles, setDepProfiles] = useState<DepProfile[] | null>(null)
  const [depRebuilding, setDepRebuilding] = useState<string | null>(null)
  const [depNote, setDepNote] = useState<string>('')
  const [depError, setDepError] = useState<string | null>(null)

  const refreshDepStatus = useCallback(async (): Promise<void> => {
    try {
      const r = await invoke<{ profiles: DepProfile[] | null }>('list_profile_dependency_status')
      setDepProfiles(r?.profiles ?? [])
    } catch (err) {
      // 不吞错：写日志并展示真实原因（#122 收尾——原提示“仅桌面壳可用”会掩盖 ACL/命令错误）
      console.error('[desktop-settings] list_profile_dependency_status 失败：', err)
      setDepError(String(err))
      setDepProfiles(null)
    }
  }, [])

  React.useEffect(() => {
    void refreshDepStatus()
  }, [refreshDepStatus])

  const handleRebuildDeps = (profile: string): void => {
    if (depRebuilding) return
    setDepRebuilding(profile)
    setDepNote(`${profile}：依赖重建中（用内置 pnpm 重装，可能需要几分钟）…`)
    void invoke('rebuild_profile_dependencies', { profile })
      .then(() => {
        setDepNote(`${profile}：依赖已重建，重启该 profile 后生效。`)
        return refreshDepStatus()
      })
      .catch((err) => setDepNote(`${profile}：重建失败 —— ${String(err)}`))
      .finally(() => setDepRebuilding(null))
  }

  return (
    <SectionBox title="依赖状态（pnpm store 一致性）">
      <div style={LABEL_STYLE}>
        dsh 的插件安装/卸载由内置 pnpm 执行；profile 的 node_modules 若由其它 pnpm 版本装过，
        store 大版本不一致会报 ERR_PNPM_UNEXPECTED_STORE。此处可查看并重建。
      </div>
      {depProfiles === null ? (
        <div style={NOTE_STYLE}>读取失败：{depError ?? '未知原因'}</div>
      ) : depProfiles.length === 0 ? (
        <div style={NOTE_STYLE}>未发现 profile</div>
      ) : (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.75 }}>
              <th style={{ padding: '4px 6px' }}>Profile</th>
              <th style={{ padding: '4px 6px' }}>依赖由 pnpm</th>
              <th style={{ padding: '4px 6px' }}>内置 pnpm</th>
              <th style={{ padding: '4px 6px' }}>状态</th>
              <th style={{ padding: '4px 6px' }} />
            </tr>
          </thead>
          <tbody>
            {depProfiles.map((p) => (
              <tr key={p.profile}>
                <td style={{ padding: '4px 6px' }}>{p.profile}</td>
                <td style={{ padding: '4px 6px', opacity: 0.85 }}>{p.recordedPnpm ?? '未知'}</td>
                <td style={{ padding: '4px 6px', opacity: 0.85 }}>{p.builtinPnpm ?? '未知'}</td>
                <td style={{ padding: '4px 6px' }}>
                  {!p.needsRebuild ? '一致' : p.running ? '需重建（运行中）' : '需重建'}
                </td>
                <td style={{ padding: '4px 6px' }}>
                  <PfBtn
                    variant="ghost"
                    disabled={!p.needsRebuild || p.running || depRebuilding !== null}
                    title={
                      p.running
                        ? '该 profile 正在运行：先停止再重建'
                        : p.needsRebuild
                          ? '用内置 pnpm 重建依赖（迁移 store 大版本）'
                          : '无需重建'
                    }
                    onClick={() => handleRebuildDeps(p.profile)}
                  >
                    {depRebuilding === p.profile ? '重建中…' : '重建'}
                  </PfBtn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {depNote ? <div style={NOTE_STYLE}>{depNote}</div> : null}
    </SectionBox>
  )
}
