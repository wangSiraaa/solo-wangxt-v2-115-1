import React, { useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import SceneViewer from './components/SceneViewer.jsx'
import ResultsPanel from './components/ResultsPanel.jsx'
import ComparisonPanel from './components/ComparisonPanel.jsx'

const DATES = ['2026-01-15', '2026-03-20', '2026-07-15'] // 跨冬夏算例日期
const LS_SCENE = 'swb.sceneId'
const cmpKey = (sceneId) => `swb.compare.${sceneId}` // 同场景历史运行对比选择，按场景持久化

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

  // 运行对比状态
  const [sceneRuns, setSceneRuns] = useState([])
  const [cmp, setCmp] = useState(null)             // 双运行对比结果
  const [cmpA, setCmpA] = useState(null)
  const [cmpB, setCmpB] = useState(null)
  const [returnPair, setReturnPair] = useState(null) // 从对比进入单运行时的返回入口

  useEffect(() => { api.scenes().then(setScenes).catch((e) => setError(String(e))) }, [])

  // 刷新后回到上次场景；该场景若存过对比选择，则自动重新打开同一对比
  useEffect(() => {
    if (!scenes.length) return
    const savedScene = Number(localStorage.getItem(LS_SCENE))
    if (savedScene && scenes.some((s) => s.id === savedScene)) setSceneId(savedScene)
    else setSceneId(scenes[0].id)
  }, [scenes])

  useEffect(() => {
    if (!sceneId) return
    let ignore = false
    localStorage.setItem(LS_SCENE, String(sceneId))
    setRun(null); setSelectedPointId(null); setTrace(null); setCmp(null)
    setReturnPair(null)
    api.scene(sceneId).then((p) => { if (!ignore) setPayload(p) })
    api.sunpath(sceneId, date).then((sp) => { if (!ignore) setSunpath(sp) })
    ;(async () => {
      try {
        const rs = await api.sceneRuns(sceneId)
        if (ignore) return
        setSceneRuns(rs)
        // 刷新后恢复同场景的对比选择（两个 run id 必须仍在历史列表中）
        const saved = JSON.parse(localStorage.getItem(cmpKey(sceneId)) || 'null')
        const valid = saved && saved.a !== saved.b
          && rs.some((r) => r.run_id === saved.a)
          && rs.some((r) => r.run_id === saved.b)
        if (!valid) { setCmpA(null); setCmpB(null); return }
        setCmpA(saved.a); setCmpB(saved.b)
        // 刷新后直接重新打开同一对比（含 A 侧快照几何）
        const c = await api.compare(saved.a, saved.b)
        const metaA = rs.find((r) => r.run_id === saved.a)
        const snap = await api.snapshot(metaA.snapshot_id)
        if (ignore) return
        setCmp(c)
        setPayload(snap.payload)
      } catch (e) {
        if (!ignore) setError(String(e))
      }
    })()
    return () => { ignore = true }
  }, [sceneId])

  useEffect(() => {
    if (sceneId && date) api.sunpath(sceneId, date).then(setSunpath)
  }, [sceneId, date])

  const doSeed = async () => { await api.seed(); setScenes(await api.scenes()) }

  const doRun = async () => {
    setError(null)
    const r = await api.run(sceneId, date, 5)
    const full = await api.runResult(r.run_id)
    setRun(full)
    setReturnPair(null)
    // 结果关联快照：渲染切换到快照内容，保证结果-场景一致可追溯
    const snap = await api.snapshot(full.snapshot_id)
    setPayload(snap.payload)
    setSceneRuns(await api.sceneRuns(sceneId))
  }

  // 选择两次运行 → 拉取对比（选择持久化，刷新页面后仍可打开同一对比）
  const chooseCompare = async (a, b) => {
    const nextA = a || null, nextB = b || null
    setError(null)
    setCmpA(nextA); setCmpB(nextB)
    if (nextA && nextB) {
      if (nextA === nextB) { setCmp(null); return }
      localStorage.setItem(cmpKey(sceneId), JSON.stringify({ a: nextA, b: nextB }))
      try {
        const c = await api.compare(nextA, nextB)
        setCmp(c)
        // 对比视图以运行 A 的快照几何渲染，保证几何-结果一致可追溯
        const metaA = sceneRuns.find((r) => r.run_id === nextA)
        if (metaA) {
          const snap = await api.snapshot(metaA.snapshot_id)
          setPayload(snap.payload)
        }
      } catch (e) {
        setCmp(null); setError(String(e))
      }
    } else {
      setCmp(null)
      localStorage.removeItem(cmpKey(sceneId))
    }
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

  // 对比模式下三维测点不显示单侧运行的着色（避免把 A 的遮挡状态误读成对比结论）
  const viewerStatus = cmp ? null : pointStatus

  // 日期下拉允许历史运行中的任意日期（超出预设冬夏日期时自动补入）
  const dateOptions = useMemo(() => {
    const all = new Set(DATES)
    if (run) all.add(run.date)
    return [...all].sort()
  }, [run])

  const doTrace = async (pointId) => {
    setTrace(await api.trace(run.run_id, pointId))
  }

  // 从对比行追查原运行：加载该运行结果 + 其快照几何，并定位测点
  const inspectRun = async (runId, pointId) => {
    setError(null)
    try {
      setReturnPair(cmpA && cmpB ? { a: cmpA, b: cmpB } : null)
      const full = await api.runResult(runId)
      setRun(full)
      setSelectedPointId(pointId)
      setCmp(null)
      const snap = await api.snapshot(full.snapshot_id)
      setPayload(snap.payload)
      setDate(full.date)
    } catch (e) {
      setError(String(e))
    }
  }

  // 从单运行追查返回到双运行对比
  const returnToCompare = async () => {
    if (!returnPair) return
    await chooseCompare(returnPair.a, returnPair.b)
  }

  const runLabel = (r) =>
    `#${r.run_id} · ${r.date} · ${r.step_minutes}min · 测点[${r.point_ids.join(',')}]`

  return (
    <div className="layout">
      <header>
        <b>日照分析工作台</b>
        <span className="badge">合成场景 · 示例评价口径 · 非规划合规结论</span>
      </header>
      <aside>
        <label>场景（坐标基准统一挂在场景上）</label>
        <select value={sceneId ?? ''} onChange={(e) => setSceneId(+e.target.value)}>
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
          {dateOptions.map((d) => <option key={d}>{d}</option>)}
        </select>
        <button disabled={!sceneId} onClick={doRun}>运行当日分析（5min 步长）</button>
        {run && <div className="muted small">当前查看 run #{run.run_id} · 快照 #{run.snapshot_id}</div>}
        {error && <div className="error">{error}</div>}
        {sunpath && !cmp && (
          <>
            <label>时刻 {sunpath.points[timeIdx]?.time.slice(11, 16)}</label>
            <input type="range" min={0} max={sunpath.points.length - 1}
              value={timeIdx} onChange={(e) => setTimeIdx(+e.target.value)} />
          </>
        )}
        {trace && (
          <div className="trace">
            <h4>遮挡物追查（测点 #{trace.point_id}）</h4>
            <div>遮挡物：{trace.occluders.join('、') || '无'}</div>
            <div className="muted small">{trace.note}</div>
            <button onClick={() => setTrace(null)}>关闭</button>
          </div>
        )}
      </aside>
      <main>
        <SceneViewer
          payload={payload} sunpath={sunpath} timeIdx={timeIdx}
          pointStatus={viewerStatus} selectedPointId={selectedPointId}
          highlightOccluder={highlightOccluder}
          onSelectPoint={setSelectedPointId}
          onSelectBuilding={setHighlightOccluder} />
      </main>
      <aside className="right">
        <div className="cmp-picker">
          <label>运行对比（同场景历史运行，仅相同步长+相同测点集合才整体可比）</label>
          <select value={cmpA ?? ''} onChange={(e) => chooseCompare(+e.target.value, cmpB)}>
            <option value="">选择运行 A…</option>
            {sceneRuns.map((r) => <option key={r.run_id} value={r.run_id}>{runLabel(r)}</option>)}
          </select>
          <select value={cmpB ?? ''} onChange={(e) => chooseCompare(cmpA, +e.target.value)}>
            <option value="">选择运行 B…</option>
            {sceneRuns.map((r) => <option key={r.run_id} value={r.run_id}>{runLabel(r)}</option>)}
          </select>
          {cmpA && cmpB && cmpA === cmpB && (
            <div className="error small">两次运行不能相同，请选择不同的运行。</div>
          )}
          {!sceneRuns.length && <div className="muted small">该场景暂无历史运行，先在左侧运行当日分析。</div>}
          {cmp && (
            <button onClick={() => {
              setCmp(null); setCmpA(null); setCmpB(null)
              if (sceneId) localStorage.removeItem(cmpKey(sceneId))
            }}>退出对比</button>
          )}
        </div>

        {cmp
          ? <ComparisonPanel cmp={cmp} selectedPointId={selectedPointId}
              onSelectPoint={setSelectedPointId} onInspectRun={inspectRun} />
          : <>
              {returnPair && (
                <button className="back-cmp" onClick={returnToCompare}>
                  ← 返回运行对比（#{returnPair.a} vs #{returnPair.b}）
                </button>
              )}
              <ResultsPanel
                run={run} result={selectedResult}
                onHoverInterval={(iv) => setHighlightOccluder(iv?.occluder ?? null)}
                onTrace={doTrace} />
            </>}
      </aside>
    </div>
  )
}
