"""双运行对比逻辑（纯函数，不依赖数据库会话，便于单测）。

口径约定（教学用，合成场景示例）：
- 测点身份按 point_id 对齐（同场景下 point_id 稳定，快照里带名称/窗号）。
- 仅当两次运行**采样步长相同**时才做数值比较；步长不同则分钟差一律留空。
- 仅一侧运行包含的测点属于**缺失项**：明确标出，绝不按 0 分钟计入差值。
- 分钟差 = 运行 A 累计日照分钟 − 运行 B 累计日照分钟（A/B 由调用方指定）。
- 主要遮挡物：细样本中被该建筑遮挡累计分钟最多者；无遮挡返回 None。
"""
from __future__ import annotations

from collections.abc import Iterable


def main_occluder(fine_samples: Iterable[dict], step_minutes: int) -> dict | None:
    """汇总一次测点结果的遮挡物：按遮挡分钟数排序，返回主要遮挡物。"""
    minutes: dict[str, int] = {}
    for s in fine_samples:
        if s.get("status") == "shaded" and s.get("occluder"):
            minutes[s["occluder"]] = minutes.get(s["occluder"], 0) + step_minutes
    if not minutes:
        return None
    ranked = sorted(minutes.items(), key=lambda kv: (-kv[1], kv[0]))
    return {
        "name": ranked[0][0],
        "shaded_minutes": ranked[0][1],
        "all_occluders": [{"name": n, "shaded_minutes": m} for n, m in ranked],
    }


def _side_view(run, result) -> dict:
    return {
        "run_id": run.id,
        "date": str(run.run_date),
        "step_minutes": run.step_minutes,
        "sunlit_minutes": result.summary["sunlit_minutes"],
        "longest_continuous_sunlit_minutes":
            result.summary["longest_continuous_sunlit_minutes"],
        "main_occluder": main_occluder(result.fine_samples, run.step_minutes),
    }


def build_comparison(run_a, run_b, results_a: dict, results_b: dict,
                     points_a: list[dict], points_b: list[dict]) -> dict:
    """构造双运行对比结构。

    results_a/b: {point_id: RunPointResult(含 summary/fine_samples)}
    points_a/b: 各自快照 payload["points"]（含 id/name/window_id），
                 代表该运行实际覆盖的测点集合。
    """
    step_equal = run_a.step_minutes == run_b.step_minutes
    ids_a = {p["id"] for p in points_a}
    ids_b = {p["id"] for p in points_b}
    point_sets_equal = ids_a == ids_b

    # 测点名称/窗号以快照为准（两侧都有时取 A）
    meta = {p["id"]: {"point_name": p.get("name", f"测点 #{p['id']}"),
                      "window_id": p.get("window_id", "")}
            for p in points_a}
    for p in points_b:
        meta.setdefault(p["id"],
                        {"point_name": p.get("name", f"测点 #{p['id']}"),
                         "window_id": p.get("window_id", "")})

    warnings = []
    if not step_equal:
        warnings.append(
            f"两次运行采样步长不同（{run_a.step_minutes} min vs "
            f"{run_b.step_minutes} min），不具数值可比性，分钟差全部留空；"
            "下表仅并列展示两侧原始数值。")
    only_a = sorted(ids_a - ids_b)
    only_b = sorted(ids_b - ids_a)
    if only_a:
        warnings.append(
            f"{len(only_a)} 个测点仅运行 A 包含（测点 #"
            + "、#".join(str(i) for i in only_a)
            + "），已标为缺失，不计为 0、不参与分钟差。")
    if only_b:
        warnings.append(
            f"{len(only_b)} 个测点仅运行 B 包含（测点 #"
            + "、#".join(str(i) for i in only_b)
            + "），已标为缺失，不计为 0、不参与分钟差。")

    rows = []
    for pid in sorted(ids_a | ids_b):
        in_a, in_b = pid in ids_a, pid in ids_b
        compared = in_a and in_b and step_equal
        a = _side_view(run_a, results_a[pid]) if in_a else None
        b = _side_view(run_b, results_b[pid]) if in_b else None
        rows.append({
            "point_id": pid,
            "point_name": meta[pid]["point_name"],
            "window_id": meta[pid]["window_id"],
            "present_in_a": in_a,
            "present_in_b": in_b,
            "a": a,
            "b": b,
            "compared": compared,
            # 缺失测点或步长不同时 diff 为 None（None != 0，前端不得按零渲染）
            "diff_minutes": (a["sunlit_minutes"] - b["sunlit_minutes"])
                            if compared else None,
        })

    return {
        "comparable": step_equal and point_sets_equal,
        "step_equal": step_equal,
        "point_sets_equal": point_sets_equal,
        "warnings": warnings,
        "run_a": {"run_id": run_a.id, "snapshot_id": run_a.snapshot_id,
                  "date": str(run_a.run_date),
                  "step_minutes": run_a.step_minutes},
        "run_b": {"run_id": run_b.id, "snapshot_id": run_b.snapshot_id,
                  "date": str(run_b.run_date),
                  "step_minutes": run_b.step_minutes},
        "points": rows,
        "note": ("按测点身份（point_id）对齐；分钟差 = A − B。"
                 "合成场景示例口径输出，不构成规划合规结论。"),
    }
