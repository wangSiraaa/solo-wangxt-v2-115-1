import React from 'react'
import { fmtMin } from '../util.js'

/** 双运行对比面板：按测点身份并列两侧日期/累计日照/分钟差/主要遮挡物。
 *  缺失测点明确标灰、不按 0 渲染；步长不同或测点集合不一致时给出醒目提示。 */
export default function ComparisonPanel({ cmp, selectedPointId, onSelectPoint, onInspectRun }) {
  const fmtSide = (v) => (v == null ? '—' : fmtMin(v))
  const fmtOccluder = (mo) => {
    if (!mo) return <span className="muted">无遮挡</span>
    return (
      <span title={mo.all_occluders
        .map((o) => `${o.name} ${fmtMin(o.shaded_minutes)}`).join('、')}>
        {mo.name}
        <span className="muted">（{fmtMin(mo.shaded_minutes)}）</span>
      </span>
    )
  }
  return (
    <div className="panel compare">
      <h3>运行对比（按测点身份对齐）</h3>
      <div className="disclaimer">
        合成场景示例口径输出；分钟差 = A − B；不构成规划合规结论。
      </div>
      <div className="cmp-sides">
        <div><b>A</b> · #{cmp.run_a.run_id} · {cmp.run_a.date} · {cmp.run_a.step_minutes}min</div>
        <div><b>B</b> · #{cmp.run_b.run_id} · {cmp.run_b.date} · {cmp.run_b.step_minutes}min</div>
      </div>

      {!cmp.comparable && (
        <div className="cmp-warning">
          {cmp.step_equal
            ? '两次运行的测点集合不完全一致，整体不具完全可比性。'
            : '两次运行采样步长不同，不进行数值比较。'}
          {cmp.warnings.map((w, i) => <div key={i}>• {w}</div>)}
        </div>
      )}

      <div className="cmp-table">
        {cmp.points.map((p) => {
          const missing = !p.present_in_a || !p.present_in_b
          return (
            <div key={p.point_id}
              className={`cmp-row ${selectedPointId === p.point_id ? 'sel' : ''} ${missing ? 'missing' : ''}`}
              onClick={() => onSelectPoint?.(p.point_id)}>
              <div className="cmp-head">
                <span className="cmp-name">#{p.point_id} {p.point_name}</span>
                {p.window_id && <span className="muted small">{p.window_id}</span>}
                {!p.compared && (
                  <span className="cmp-badge">
                    {missing ? '测点缺失' : '步长不可比'}
                  </span>
                )}
              </div>
              <table>
                <tbody>
                  <tr>
                    <th>日期</th>
                    <td className="side-a">{p.a ? p.a.date : <em>缺失</em>}</td>
                    <td className="side-b">{p.b ? p.b.date : <em>缺失</em>}</td>
                  </tr>
                  <tr>
                    <th>累计日照</th>
                    <td className="side-a">{p.a ? fmtSide(p.a.sunlit_minutes) : <em>—</em>}</td>
                    <td className="side-b">{p.b ? fmtSide(p.b.sunlit_minutes) : <em>—</em>}</td>
                  </tr>
                  <tr>
                    <th>最长连续</th>
                    <td>{p.a ? fmtSide(p.a.longest_continuous_sunlit_minutes) : <em>—</em>}</td>
                    <td>{p.b ? fmtSide(p.b.longest_continuous_sunlit_minutes) : <em>—</em>}</td>
                  </tr>
                  <tr>
                    <th>分钟差</th>
                    <td colSpan={2}>
                      {p.diff_minutes == null
                        ? <em className="muted">不可比（不按 0 计）</em>
                        : <Diff value={p.diff_minutes} />}
                    </td>
                  </tr>
                  <tr>
                    <th>主要遮挡物</th>
                    <td>{p.a ? fmtOccluder(p.a.main_occluder) : <em>—</em>}</td>
                    <td>{p.b ? fmtOccluder(p.b.main_occluder) : <em>—</em>}</td>
                  </tr>
                </tbody>
              </table>
              <div className="cmp-actions">
                {p.a && (
                  <button onClick={(e) => { e.stopPropagation(); onInspectRun?.(cmp.run_a.run_id, p.point_id) }}>
                    追查 A 运行
                  </button>
                )}
                {p.b && (
                  <button onClick={(e) => { e.stopPropagation(); onInspectRun?.(cmp.run_b.run_id, p.point_id) }}>
                    追查 B 运行
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="muted small">{cmp.note}</div>
    </div>
  )
}

function Diff({ value }) {
  const cls = value > 0 ? 'pos' : value < 0 ? 'neg' : 'zero'
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return (
    <b className={`diff ${cls}`}>
      {sign}{Math.abs(value)} min
      {value !== 0 && <span className="muted">（{sign}{fmtMin(Math.abs(value))}）</span>}
    </b>
  )
}
