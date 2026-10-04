"""双运行对比逻辑测试（不依赖 PostgreSQL，用内存对象模拟 ORM 行）。

覆盖：
- 步长相同+测点集合相同：各测点分钟差 = A−B，主要遮挡物按遮挡分钟归并；
- 步长不同：整体不可比，所有分钟差留空（绝不用 0 顶替），仅并列原始值；
- 测点缺失：显式标 present_in_*=False 且 diff 为 None，不算作零；
  共有测点在步长相同时仍给出分钟差（部分可比）。
"""
from datetime import date
from types import SimpleNamespace as NS

from app.compare import build_comparison, main_occluder

POINTS_A = [
    {"id": 1, "name": "W1_一层南窗_左", "window_id": "W1"},
    {"id": 2, "name": "W1_一层南窗_中", "window_id": "W1"},
]
POINTS_B_FULL = list(POINTS_A)
POINTS_B_PARTIAL = POINTS_A[1:]  # B 缺测点 1


def _run(rid, step, d="2026-01-15", snap=None):
    return NS(id=rid, scene_id=1, snapshot_id=snap or rid,
              run_date=date.fromisoformat(d), step_minutes=step,
              results=[])


def _result(sunlit, longest, samples):
    return NS(summary={"sunlit_minutes": sunlit,
                       "longest_continuous_sunlit_minutes": longest,
                       "criterion": "示例口径"},
              fine_samples=samples)


def _samples(occluder_counts, step=5):
    """occluder_counts: {遮挡物: 被遮挡样本数}；另补 2 个晒到样本。"""
    out = [{"time": "2026-01-15T12:00:00+08:00", "status": "sunlit",
            "occluder": None}] * 2
    for name, n in occluder_counts.items():
        out += [{"time": "2026-01-15T09:00:00+08:00", "status": "shaded",
                 "occluder": name}] * n
    return out


def test_comparable_pair_diff_and_main_occluder():
    ra, rb = _run(10, 5, "2026-01-15"), _run(11, 5, "2026-07-15")
    res_a = {1: _result(100, 60, _samples({"B1_南侧板楼": 4})),
             2: _result(200, 120, _samples({}))}
    res_b = {1: _result(250, 150, _samples({})),
             2: _result(200, 120, _samples({"B2_东南塔楼": 3}))}
    cmp_ = build_comparison(ra, rb, res_a, res_b, POINTS_A, POINTS_B_FULL)
    assert cmp_["comparable"] is True
    assert cmp_["warnings"] == []
    rows = {r["point_id"]: r for r in cmp_["points"]}
    assert rows[1]["diff_minutes"] == 100 - 250
    assert rows[2]["diff_minutes"] == 0
    # 两侧日期与原始累计分钟都在
    assert rows[1]["a"]["date"] == "2026-01-15"
    assert rows[1]["b"]["date"] == "2026-07-15"
    assert rows[1]["a"]["sunlit_minutes"] == 100
    assert rows[1]["b"]["sunlit_minutes"] == 250
    # 主要遮挡物：A 侧测点 1 被 B1 遮挡 20 min；B 侧测点 1 无遮挡
    assert rows[1]["a"]["main_occluder"]["name"] == "B1_南侧板楼"
    assert rows[1]["a"]["main_occluder"]["shaded_minutes"] == 20
    assert rows[1]["b"]["main_occluder"] is None
    assert rows[2]["b"]["main_occluder"]["name"] == "B2_东南塔楼"
    assert "合成场景示例" in cmp_["note"]


def test_different_step_is_not_numerically_comparable():
    ra, rb = _run(10, 5), _run(11, 10)
    res = {1: _result(100, 60, _samples({"B1_南侧板楼": 2})),
           2: _result(200, 120, _samples({}))}
    cmp_ = build_comparison(ra, rb, res, res, POINTS_A, POINTS_B_FULL)
    assert cmp_["comparable"] is False
    assert cmp_["step_equal"] is False
    assert any("步长" in w for w in cmp_["warnings"])
    for row in cmp_["points"]:
        # 步长不同：分钟差一律 None，且两侧原始值仍可见
        assert row["diff_minutes"] is None
        assert row["a"]["sunlit_minutes"] == row["b"]["sunlit_minutes"]
        assert row["compared"] is False


def test_missing_point_is_flagged_not_zero():
    ra, rb = _run(10, 5, "2026-01-15"), _run(12, 5, "2026-07-15")
    res_a = {1: _result(100, 60, _samples({})), 2: _result(200, 120, _samples({}))}
    res_b = {2: _result(260, 200, _samples({}))}  # B 运行只跑了测点 2
    cmp_ = build_comparison(ra, rb, res_a, res_b, POINTS_A, POINTS_B_PARTIAL)
    assert cmp_["comparable"] is False
    assert cmp_["step_equal"] is True
    assert cmp_["point_sets_equal"] is False
    rows = {r["point_id"]: r for r in cmp_["points"]}
    # 缺失测点：B 侧留空、diff 为 None（不能是 0−100=−100）
    assert rows[1]["present_in_a"] is True
    assert rows[1]["present_in_b"] is False
    assert rows[1]["b"] is None
    assert rows[1]["diff_minutes"] is None
    assert rows[1]["compared"] is False
    assert any("测点 #1" in w and "缺失" in w for w in cmp_["warnings"])
    # 共有测点步长相同 → 仍给出分钟差（部分可比）
    assert rows[2]["present_in_a"] and rows[2]["present_in_b"]
    assert rows[2]["diff_minutes"] == 200 - 260
    assert rows[2]["compared"] is True
    # 并集对齐：两个测点都出现
    assert sorted(rows) == [1, 2]


def test_main_occluder_picks_longest_total():
    samples = (_samples({"B1_南侧板楼": 6})
               + _samples({"B2_东南塔楼": 2})[2:])
    mo = main_occluder(samples, step_minutes=5)
    assert mo["name"] == "B1_南侧板楼"
    assert mo["shaded_minutes"] == 30
    assert {o["name"] for o in mo["all_occluders"]} == {
        "B1_南侧板楼", "B2_东南塔楼"}
    assert main_occluder(_samples({}), 5) is None
