"""双运行对比逻辑测试（不依赖 PostgreSQL）。

覆盖验收口径：
- 同场景同步长：逐测点给出两侧累计分钟与分钟差（B − A），缺项不算 0；
- 步长不同：明确提示且不产出任何数值比较；
- 测点集合不同：缺失测点显式标记 missing_in_a / missing_in_b；
- 主要遮挡物按遮挡分钟数排序；
- 端点层：同场景校验、快照取测点身份、disclaimer 透传。
"""
from datetime import date, datetime
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient

from app import models
from app.analysis import MeasurePointGeom, analyze_point
from app.compare import build_comparison, main_occluders
from app.db import get_db
from app.geometry import BuildingGeom, box_footprint, build_scene
from app.main import app
from app.seed import scene_specs, LAT, LON, TZ


def _result(sunlit: int, shaded_by: list[str], step: int = 5) -> dict:
    """合成与 summary 自洽的细样本序列（night 不计入白天口径）。"""
    samples = ([{"time": f"2026-01-15T0{i}:00:00+08:00", "status": "sunlit",
                 "occluder": None} for i in range(sunlit)]
               + [{"time": f"2026-01-15T1{j}:00:00+08:00", "status": "shaded",
                   "occluder": occ} for j, occ in enumerate(shaded_by)])
    return {
        "summary": {
            "daylight_minutes": len(samples) * step,
            "sunlit_minutes": sunlit * step,
            "longest_continuous_sunlit_minutes": sunlit * step,
            "criterion": "测试合成",
        },
        "fine_samples": samples,
    }


META_A = {"run_id": 1, "date": "2026-01-15", "step_minutes": 5}
META_B = {"run_id": 2, "date": "2026-07-15", "step_minutes": 5}
NAMES = {1: {"name": "W1_一层南窗_左", "window_id": "W1"},
         2: {"name": "W2_三层南窗_中", "window_id": "W2"},
         3: {"name": "W3_六层南窗_中", "window_id": "W3"}}


def test_main_occluders_ranked_by_shaded_minutes():
    samples = [{"status": "shaded", "occluder": o} for o in
               ["B1", "B1", "B1", "B2", "B2", "T"]] + \
              [{"status": "sunlit", "occluder": None},
               {"status": "night", "occluder": None}]
    ranked = main_occluders(samples, step_minutes=5, top=2)
    assert ranked == [{"name": "B1", "shaded_minutes": 15},
                      {"name": "B2", "shaded_minutes": 10}]


def test_compare_same_step_diff_is_b_minus_a():
    out = build_comparison(
        META_A, {1: _result(10, ["B1"]), 2: _result(20, [])}, NAMES,
        META_B, {1: _result(30, []), 2: _result(20, ["B2"])}, NAMES)
    assert out["comparable"] and not out["issues"]
    rows = {r["point_id"]: r for r in out["points"]}
    # 点1：冬 50min → 夏 150min，差 +100；两侧原始值都在
    assert rows[1]["a"]["sunlit_minutes"] == 50
    assert rows[1]["b"]["sunlit_minutes"] == 150
    assert rows[1]["diff_minutes"] == 100
    assert rows[1]["a"]["main_occluders"] == [
        {"name": "B1", "shaded_minutes": 5}]
    assert rows[1]["b"]["main_occluders"] == []
    # 点2：两侧都是 100min → 差 0（真 0，不是缺项占位）
    assert rows[2]["diff_minutes"] == 0
    assert rows[2]["status"] == "compared"
    assert out["totals"]["points_compared"] == 2
    assert out["totals"]["points_changed"] == 1


def test_compare_missing_point_marked_not_zero():
    out = build_comparison(
        META_A, {1: _result(10, []), 2: _result(20, [])}, NAMES,
        META_B, {1: _result(30, [])}, NAMES)  # 运行B 缺测点 2
    assert out["comparable"]          # 仍有共同测点 → 可比
    rows = {r["point_id"]: r for r in out["points"]}
    assert rows[2]["status"] == "missing_in_b"
    assert rows[2]["b"] is None
    assert rows[2]["diff_minutes"] is None      # 缺项 ≠ 0
    assert rows[1]["diff_minutes"] == 100       # 共同测点正常比较
    assert out["totals"]["points_compared"] == 1
    assert out["totals"]["points_missing_in_b"] == 1
    assert any("缺失" in i and "W2_三层南窗_中" in i for i in out["issues"])


def test_compare_step_mismatch_no_numeric_compare():
    meta_b = {**META_B, "step_minutes": 10}
    out = build_comparison(
        META_A, {1: _result(10, [])}, NAMES,
        meta_b, {1: _result(10, [], step=10)}, NAMES)
    assert not out["comparable"]
    assert out["points"] == []                  # 不纳入数值比较
    assert out["totals"]["points_changed"] is None
    assert any("步长" in i for i in out["issues"])


def test_compare_disjoint_points_not_comparable():
    out = build_comparison(META_A, {1: _result(10, [])}, NAMES,
                           META_B, {2: _result(10, [])}, NAMES)
    assert not out["comparable"]
    assert any("共同测点" in i for i in out["issues"])


def test_compare_real_s1_winter_vs_summer():
    """用真实分析管线跑 S1 冬夏两次，对比结果必须冬季<夏季（手算已知）。"""
    spec = scene_specs()[0]
    built = build_scene([BuildingGeom(
        name=b["name"], footprint=b["footprint"],
        base_height=b["base_height"], top_height=b["top_height"])
        for b in spec["buildings"]])
    results = {}
    for tag, day in (("winter", "2026-01-15"), ("summer", "2026-07-15")):
        results[tag] = {}
        for i, p in enumerate(spec["points"], 1):
            pt = MeasurePointGeom(id=str(i), name=p["name"],
                                  position=p["position"], normal=p["normal"])
            results[tag][i] = analyze_point(
                built, pt, latitude=LAT, longitude=LON, tz=TZ, date=day,
                north_offset_deg=spec["north_offset_deg"], step_minutes=5)
    names = {i: {"name": p["name"], "window_id": p["window_id"]}
             for i, p in enumerate(spec["points"], 1)}
    out = build_comparison({"run_id": 1, "date": "2026-01-15", "step_minutes": 5},
                           results["winter"], names,
                           {"run_id": 2, "date": "2026-07-15", "step_minutes": 5},
                           results["summer"], names)
    assert out["comparable"]
    assert len(out["points"]) == len(spec["points"])
    # 南窗一层：冬季被南侧板楼遮挡，夏季明显更长 → diff 为正
    w1 = next(r for r in out["points"] if r["name"] == "W1_一层南窗_左")
    assert w1["diff_minutes"] > 0
    assert w1["a"]["main_occluders"][0]["name"] == "B1_南侧板楼"


# ---------- 端点层（FakeDB 替代 ORM 会话） ----------

class _FakeDB:
    def __init__(self, objs):
        self._objs = objs

    def get(self, model, ident):
        return self._objs.get((model, ident))


def _fake_run(run_id, scene_id, snapshot_id, run_date, step, results):
    return NS(id=run_id, scene_id=scene_id, snapshot_id=snapshot_id,
              run_date=run_date, step_minutes=step,
              created_at=datetime(2026, 1, 1), results=results)


def _fake_result(point_id, result):
    return NS(point_id=point_id, summary=result["summary"],
              fine_samples=result["fine_samples"])


@pytest.fixture()
def client():
    snap1 = NS(id=11, payload={"points": [
        {"id": 1, "name": "W1_一层南窗_左", "window_id": "W1"},
        {"id": 2, "name": "W2_三层南窗_中", "window_id": "W2"}]})
    snap2 = NS(id=12, payload={"points": [
        {"id": 1, "name": "W1_一层南窗_左", "window_id": "W1"}]})
    run1 = _fake_run(1, 7, 11, date(2026, 1, 15), 5,
                     [_fake_result(1, _result(10, ["B1_南侧板楼"])),
                      _fake_result(2, _result(20, []))])
    run2 = _fake_run(2, 7, 12, date(2026, 7, 15), 5,
                     [_fake_result(1, _result(30, []))])
    run3 = _fake_run(3, 7, 12, date(2026, 7, 15), 10,   # 步长不同
                     [_fake_result(1, _result(10, [], step=10))])
    run_other_scene = _fake_run(9, 8, 12, date(2026, 7, 15), 5, [])
    fake = _FakeDB({(models.Run, 1): run1, (models.Run, 2): run2,
                    (models.Run, 3): run3, (models.Run, 9): run_other_scene,
                    (models.Snapshot, 11): snap1, (models.Snapshot, 12): snap2})
    app.dependency_overrides[get_db] = lambda: fake
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_endpoint_compare_ok(client):
    r = client.get("/api/analysis/compare?run_a=1&run_b=2")
    assert r.status_code == 200
    out = r.json()
    assert out["comparable"]
    assert out["run_a"]["date"] == "2026-01-15"
    assert out["run_b"]["date"] == "2026-07-15"
    rows = {p["point_id"]: p for p in out["points"]}
    assert rows[1]["name"] == "W1_一层南窗_左"     # 身份取自快照
    assert rows[1]["diff_minutes"] == 100
    assert rows[2]["status"] == "missing_in_b"
    assert rows[2]["diff_minutes"] is None
    assert "合成场景" in out["disclaimer"]


def test_endpoint_compare_step_mismatch(client):
    out = client.get("/api/analysis/compare?run_a=1&run_b=3").json()
    assert not out["comparable"]
    assert out["points"] == []
    assert any("步长" in i for i in out["issues"])


def test_endpoint_compare_cross_scene_rejected(client):
    r = client.get("/api/analysis/compare?run_a=1&run_b=9")
    assert r.status_code == 400
    assert "同一场景" in r.json()["detail"]


def test_endpoint_compare_run_not_found(client):
    assert client.get("/api/analysis/compare?run_a=1&run_b=99").status_code == 404


# ---------- 运行历史列表端点 ----------

class _FakeQuery:
    """模拟测试用到的最小 query 链：filter_by / order_by / filter(in_) / all。"""

    def __init__(self, rows, key=None):
        self._rows = rows
        self._key = key or (lambda r: r)

    def filter_by(self, **kw):
        return _FakeQuery([r for r in self._rows
                           if all(getattr(r, k) == v for k, v in kw.items())])

    def order_by(self, *_):
        return _FakeQuery(sorted(self._rows, key=lambda r: r.id, reverse=True))

    def filter(self, criterion):
        wanted = set(criterion.right.value)
        return _FakeQuery([r for r in self._rows
                           if self._key(r)[0] in wanted], self._key)

    def all(self):
        return self._rows


class _ListDB:
    def __init__(self, scene, runs, result_rows):
        self._scene, self._runs, self._rows = scene, runs, result_rows

    def get(self, model, ident):
        return self._scene if model is models.Scene and ident == 7 else None

    def query(self, model, *cols):
        if model is models.Run:
            return _FakeQuery(self._runs)
        return _FakeQuery(self._rows, key=lambda r: (r[0],))


@pytest.fixture()
def list_client():
    scene = NS(id=7)
    runs = [NS(id=2, scene_id=7, snapshot_id=12, run_date=date(2026, 7, 15),
               step_minutes=5, created_at=datetime(2026, 7, 15)),
            NS(id=1, scene_id=7, snapshot_id=11, run_date=date(2026, 1, 15),
               step_minutes=5, created_at=datetime(2026, 1, 15))]
    rows = [(1, 10), (1, 11), (2, 10)]   # (run_id, point_id)
    app.dependency_overrides[get_db] = lambda: _ListDB(scene, runs, rows)
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_endpoint_list_runs(list_client):
    r = list_client.get("/api/scenes/7/runs")
    assert r.status_code == 200
    out = r.json()
    assert [x["run_id"] for x in out] == [2, 1]          # 新的在前
    assert out[1]["date"] == "2026-01-15"
    assert out[1]["point_ids"] == [10, 11]
    assert out[0]["point_count"] == 1
    assert out[0]["snapshot_id"] == 12


def test_endpoint_list_runs_scene_missing(list_client):
    assert list_client.get("/api/scenes/99/runs").status_code == 404
