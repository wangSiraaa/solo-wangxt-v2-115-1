import React from 'react'
import { fmtMin, fmtSignedMin } from '../util.js'

function fmtOcc(list) {
  if (!list?.length) return '无'
  return list.map((o) => `${o.name} ${fmtMin(o.shaded_minutes)}`).join('、')
}

function SideValue({ side }) {
  if (!side) return <span className="missing-badge">缺失</span>
  return <>{fmtMin(side.sunlit_minutes)}</>
}

/** 单侧运行详情（对比面板内，点击测点后展开，可分别追查原运行）。 */
function SideDetail({ tag, meta, side, onTrace, pointId }) {
  if (!side) {
    return (
      <div className="side-detail missing">
        <b>{tag}</b>：运行 #{meta.run_id}（{meta.date}）中该测点缺失，
        未参与该次分析——缺项不按 0 计入。
      </div>
    )
  }
  return (
    <div className="side-detail">
      <div><b>{tag}</b>：运行 #{meta.run_id} · {meta.date} · 步长 {meta.step_minutes} min</div>
      <div>连续口径·累计日照 <b>{fmtMin(side.sunlit_minutes)}</b>
        　· 最长连续 {fmtMin(side.longest_continuous_sunlit_minutes)}</div>
      <div>主要遮挡物：{fmtOcc(side.main_occluders)}</div>
      <button onClick={() => onTrace?.(meta.run_id, pointId)}>
        追查{tag}（运行 #{meta.run_id}）全部遮挡物
      </button>
    </div>
  )
}

/** 双运行对比面板：同场景两次运行按测点身份对齐展示差异。
    缺项显式标记、绝不当 0；步长不一致时只显示原因，不做数值比较。 */
export default function ComparePanel({ compare, selectedPointId, onSelectPoint,
                                      onTrace, onClose }) {
  const { run_a: A, run_b: B } = compare
  const sel = compare.points.find((p) => p.point_id === selectedPointId)
  return (
    <div className="panel">
      <h3>运行对比（合成场景示例）</h3>
      <div className="meta">
        <div>基准 A：运行 #{A.run_id} · <b>{A.date}</b> · 步长 {A.step_minutes} min · 快照 #{A.snapshot_id}</div>
        <div>对比 B：运行 #{B.run_id} · <b>{B.date}</b> · 步长 {B.step_minutes} min · 快照 #{B.snapshot_id}</div>
        <div className="muted small">{compare.diff_convention}</div>
      </div>
      <div className="disclaimer">{compare.disclaimer}</div>
      {compare.issues.map((msg, i) => <div key={i} className="warn issue">{msg}</div>)}

      {!compare.comparable ? (
        <div className="muted">两次运行不满足数值比较条件，未生成差异表。</div>
      ) : (
        <>
          <div className="muted small">
            共同测点 {compare.totals.points_compared} 个，
            其中 {compare.totals.points_changed} 个连续日照分钟发生变化
            {compare.totals.points_missing_in_a + compare.totals.points_missing_in_b > 0 &&
              `；缺失 ${compare.totals.points_missing_in_a + compare.totals.points_missing_in_b} 项（不计 0）`}
          </div>
          <table className="compare-table">
            <thead>
              <tr>
                <th>测点</th>
                <th>A {A.date}</th>
                <th>B {B.date}</th>
                <th>Δ分钟</th>
                <th>主要遮挡物</th>
              </tr>
            </thead>
            <tbody>
              {compare.points.map((p) => (
                <tr key={p.point_id}
                  className={p.point_id === selectedPointId ? 'selected' : ''}
                  onClick={() => onSelectPoint?.(p.point_id)}>
                  <td>{p.name}</td>
                  <td><SideValue side={p.a} /></td>
                  <td><SideValue side={p.b} /></td>
                  <td className={p.diff_minutes > 0 ? 'diff-pos'
                    : p.diff_minutes < 0 ? 'diff-neg' : ''}>
                    {fmtSignedMin(p.diff_minutes)}
                  </td>
                  <td className="small">
                    {p.status === 'compared' ? (
                      <>
                        <div>A: {fmtOcc(p.a.main_occluders)}</div>
                        <div>B: {fmtOcc(p.b.main_occluders)}</div>
                      </>
                    ) : (p.status === 'missing_in_b'
                      ? <span className="missing-badge">B 缺失</span>
                      : <span className="missing-badge">A 缺失</span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small">点击行或三维视图中的测点球，分侧追查原运行。</div>

          {sel && (
            <div className="compare-detail">
              <h4>测点 {sel.name}{sel.window_id ? `（窗 ${sel.window_id}）` : ''}</h4>
              {sel.status === 'compared' && (
                <div>Δ 连续口径累计日照：<b>{fmtSignedMin(sel.diff_minutes)}</b></div>
              )}
              <SideDetail tag="基准 A" meta={A} side={sel.a}
                onTrace={onTrace} pointId={sel.point_id} />
              <SideDetail tag="对比 B" meta={B} side={sel.b}
                onTrace={onTrace} pointId={sel.point_id} />
            </div>
          )}
        </>
      )}
      <button onClick={onClose}>关闭对比</button>
    </div>
  )
}
