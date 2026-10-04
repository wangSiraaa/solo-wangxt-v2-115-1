import React, { useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import SceneViewer from './components/SceneViewer.jsx'
import ResultsPanel from './components/ResultsPanel.jsx'
import ComparePanel from './components/ComparePanel.jsx'

const DATES = ['2026-01-15', '2026-03-20', '2026-07-15'] // 跨冬夏算例日期

const runLabel = (r) =>
  `#${r.run_id} · ${r.date} · 步长${r.step_minutes}min · ${r.point_count}点`

export default function App() {
  const [scenes, setScenes] = useState([])
  const [sceneId, setSceneId] = useState(null)
  const [payload, setPayload] = useState(null)   // 场景或快照内容
  const [date, setDate] = useState(DATES[0])
  const [sunpath, setSunpath] = useState(null)
  const [timeIdx, setTimeIdx] = useState(30)
  const [run, setRun] = useState(null)
  const [selectedPointId, setSelectedPointId] = useState(null)
  const [highlightOccluder, setHighlightOccluder] = useState(null)
  const [trace, setTrace] = useState(null)
  const [error, setError] = useState(null)
  // 运行对比
  const [runs, setRuns] = useState([])
  const [runAId, setRunAId] = useState(null)
  const [runBId, setRunBId] = useState(null)
  const [compare, setCompare] = useState(null)
  const [comparePointId, setComparePointId] = useState(null)
  const [pendingCompare, setPendingCompare] = useState(null) // URL 恢复用

  // 首次加载：场景列表 + 从 URL 恢复（?scene=..&compare=A,B，刷新后仍可打开同一对比）
  useEffect(() => {
    api.scenes().then(setScenes).catch((e) => setError(String(e)))
    const q = new URLSearchParams(window.location.search)
    const sid = +q.get('scene')
    if (sid) {
      setSceneId(sid)
      const [a, b] = (q.get('compare') || '').split(',').map(Number)
      if (a && b) setPendingCompare({ a, b })
    }
  }, [])

  useEffect(() => {
    if (!sceneId) return
    setRun(null); setSelectedPointId(null); setTrace(null)
    api.scene(sceneId).then(setPayload)
    api.sunpath(sceneId, date).then(setSunpath)
    api.runs(sceneId).then(setRuns).catch(() => setRuns([]))
  }, [sceneId, date])

  // URL 指定的对比在场景就绪后自动打开
  useEffect(() => {
    if (!pendingCompare || !sceneId) return
    doCompare(pendingCompare.a, pendingCompare.b)
    setPendingCompare(null)
  }, [pendingCompare, sceneId])

  const syncUrl = (sid, cmp) => {
    const u = new URL(window.location)
    if (sid) u.searchParams.set('scene', sid)
    if (cmp) u.searchParams.set('compare', `${cmp.a},${cmp.b}`)
    else u.searchParams.delete('compare')
    window.history.replaceState(null, '', u)
  }

  const selectScene = (id) => {
    setSceneId(id)
    setCompare(null); setComparePointId(null)
    setRunAId(null); setRunBId(null)
    syncUrl(id, null)
  }

  const doSeed = async () => { await api.seed(); setScenes(await api.scenes()) }

  const doRun = async () => {
    setError(null)
    const r = await api.run(sceneId, date, 5)
    const full = await api.runResult(r.run_id)
    setRun(full)
    // 结果关联快照：渲染切换到快照内容，保证结果-场景一致可追溯
    const snap = await api.snapshot(full.snapshot_id)
    setPayload(snap.payload)
    setRuns(await api.runs(sceneId))   // 新运行进入历史列表，可参与对比
  }

  const doCompare = async (a, b) => {
    setError(null)
    try {
      const out = await api.compare(a, b)
      setCompare(out)
      setComparePointId(null)
      setRunAId(a); setRunBId(b)
      syncUrl(sceneId, { a, b })
    } catch (e) {
      setCompare(null)
      setError(`对比失败：${e.message}`)
    }
  }

  const closeCompare = () => {
    setCompare(null); setComparePointId(null)
    syncUrl(sceneId, null)
  }

  // 当前时刻各测点状态（取最近细样本）
  const pointStatus = useMemo(() => {
    if (!run || !sunpath) return null
    const t = sunpath.points[timeIdx]?.time
    if (!t) return null
    const out = {}
    for (const res of run.results) {
      let best = null
      for (const s of res.fine_samples) {
        if (!best || Math.abs(s.time.localeCompare(t)) < Math.abs(best.time.localeCompare(t))) best = s
      }
      out[res.point_id] = best
    }
    return out
  }, [run, sunpath, timeIdx])

  const selectedResult = run?.results.find((r) => r.point_id === selectedPointId)

  // 追查可针对任意一次原运行（对比视图分侧追查）
  const doTrace = async (runId, pointId) => {
    const t = await api.trace(runId, pointId)
    setTrace({ ...t, run_id: runId })
  }

  const handleSelectPoint = (pid) => {
    if (compare) setComparePointId(pid)
    else setSelectedPointId(pid)
  }

  return (
    <div className="layout">
      <header>
        <b>日照分析工作台</b>
        <span className="badge">合成场景 · 示例评价口径 · 非规划合规结论</span>
      </header>
      <aside>
        <label>场景（坐标基准统一挂在场景上）</label>
        <select value={sceneId ?? ''} onChange={(e) => selectScene(+e.target.value)}>
          <option value="" disabled>选择场景</option>
          {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {!scenes.length && <button onClick={doSeed}>初始化合成场景</button>}
        {payload && (
          <div className="meta">
            <div>经纬度 {payload.scene.latitude}, {payload.scene.longitude}</div>
            <div>时区 {payload.scene.timezone}</div>
            <div>模型北偏角 {payload.scene.north_offset_deg}°</div>
            <div className="warn">未建模遮挡：{payload.scene.unmodeled_occluders}</div>
          </div>
        )}
        <label>日期（跨冬夏算例）</label>
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          {DATES.map((d) => <option key={d}>{d}</option>)}
        </select>
        <button disabled={!sceneId} onClick={doRun}>运行当日分析（5min 步长）</button>
        {run && <div className="muted small">run #{run.run_id} · 快照 #{run.snapshot_id}</div>}
        {error && <div className="error">{error}</div>}

        {runs.length > 0 && (
          <>
            <label>运行对比（同场景历史运行，数值比较要求同步长）</label>
            <select value={runAId ?? ''} onChange={(e) => setRunAId(+e.target.value)}>
              <option value="" disabled>基准运行 A（如冬季）</option>
              {runs.map((r) => <option key={r.run_id} value={r.run_id}>{runLabel(r)}</option>)}
            </select>
            <select value={runBId ?? ''} onChange={(e) => setRunBId(+e.target.value)}>
              <option value="" disabled>对比运行 B（如夏季）</option>
              {runs.map((r) => <option key={r.run_id} value={r.run_id}>{runLabel(r)}</option>)}
            </select>
            <button disabled={!runAId || !runBId || runAId === runBId}
              onClick={() => doCompare(runAId, runBId)}>
              对比两次运行
            </button>
            {compare && (
              <div className="muted small">
                对比中：#{compare.run_a.run_id} vs #{compare.run_b.run_id}
                （链接已可分享/刷新保持）
              </div>
            )}
          </>
        )}

        {sunpath && (
          <>
            <label>时刻 {sunpath.points[timeIdx]?.time.slice(11, 16)}</label>
            <input type="range" min={0} max={sunpath.points.length - 1}
              value={timeIdx} onChange={(e) => setTimeIdx(+e.target.value)} />
          </>
        )}
        {trace && (
          <div className="trace">
            <h4>遮挡物追查（测点 #{trace.point_id} · 运行 #{trace.run_id}）</h4>
            <div>遮挡物：{trace.occluders.join('、') || '无'}</div>
            <div className="muted small">{trace.note}</div>
            <button onClick={() => setTrace(null)}>关闭</button>
          </div>
        )}
      </aside>
      <main>
        <SceneViewer
          payload={payload} sunpath={sunpath} timeIdx={timeIdx}
          pointStatus={pointStatus}
          selectedPointId={compare ? comparePointId : selectedPointId}
          highlightOccluder={highlightOccluder}
          onSelectPoint={handleSelectPoint}
          onSelectBuilding={setHighlightOccluder} />
      </main>
      <aside className="right">
        {compare ? (
          <ComparePanel
            compare={compare} selectedPointId={comparePointId}
            onSelectPoint={setComparePointId}
            onTrace={doTrace}
            onClose={closeCompare} />
        ) : (
          <ResultsPanel
            run={run} result={selectedResult}
            onHoverInterval={(iv) => setHighlightOccluder(iv?.occluder ?? null)}
            onTrace={(pid) => run && doTrace(run.run_id, pid)} />
        )}
      </aside>
    </div>
  )
}
