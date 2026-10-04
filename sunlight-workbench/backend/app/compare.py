"""双运行对比（纯逻辑，不依赖 ORM，便于手算核对）。

可比性规则（不满足则不产出任何数值差，只给出原因）：
1. 两次运行必须属于同一场景；
2. 采样步长必须一致——步长不同则"连续口径分钟数"不可直接相减；
3. 至少存在一个共同测点（按测点身份 point_id 对齐）。

测点缺失（只出现在单侧运行）不是致命问题：该行明确标记
missing_in_a / missing_in_b，diff 为 None——**缺项绝不当作 0**，
汇总统计也只覆盖两侧都有的测点。
"""
from __future__ import annotations

from .analysis import STATUS_SHADED

DIFF_CONVENTION = "diff_minutes = B − A（正数表示 B 侧日照更多）"


def main_occluders(fine_samples: list[dict], step_minutes: int,
                   top: int = 3) -> list[dict]:
    """按遮挡分钟数降序的主要遮挡物（同名并列时按名称排序，保证确定性）。"""
    counts: dict[str, int] = {}
    for s in fine_samples:
        if s["status"] == STATUS_SHADED and s.get("occluder"):
            counts[s["occluder"]] = counts.get(s["occluder"], 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [{"name": name, "shaded_minutes": n * step_minutes}
            for name, n in ranked[:top]]


def _side(result: dict, step_minutes: int) -> dict:
    """单侧数值：连续口径分钟 + 主要遮挡物（原始值，不做任何加工）。"""
    return {
        "sunlit_minutes": result["summary"]["sunlit_minutes"],
        "longest_continuous_sunlit_minutes":
            result["summary"]["longest_continuous_sunlit_minutes"],
        "daylight_minutes": result["summary"]["daylight_minutes"],
        "main_occluders": main_occluders(result["fine_samples"], step_minutes),
    }


def build_comparison(meta_a: dict, results_a: dict[int, dict],
                     points_a: dict[int, dict],
                     meta_b: dict, results_b: dict[int, dict],
                     points_b: dict[int, dict]) -> dict:
    """构造双运行对比结果。

    meta_*:  {"run_id", "date", "step_minutes", ...}（原样回填到响应里）
    results_*: {point_id: {"summary": ..., "fine_samples": ...}}
    points_*:  {point_id: {"name": ..., "window_id": ...}}（取自各自快照）
    """
    issues: list[str] = []
    step_match = meta_a["step_minutes"] == meta_b["step_minutes"]
    if not step_match:
        issues.append(
            f"采样步长不同（运行A {meta_a['step_minutes']} min vs "
            f"运行B {meta_b['step_minutes']} min）：连续口径分钟数不可直接"
            "相减，本次不纳入数值比较。请用相同步长重新运行后再对比。")

    common = sorted(set(results_a) & set(results_b))
    if step_match and not common:
        issues.append("两次运行没有共同测点（按测点身份对齐），无法数值比较。")

    comparable = step_match and bool(common)

    rows, missing_names = [], []
    for pid in sorted(set(results_a) | set(results_b)):
        info = points_a.get(pid) or points_b.get(pid) or {}
        in_a, in_b = pid in results_a, pid in results_b
        row = {
            "point_id": pid,
            "name": info.get("name", f"#{pid}"),
            "window_id": info.get("window_id", ""),
            "a": _side(results_a[pid], meta_a["step_minutes"]) if in_a else None,
            "b": _side(results_b[pid], meta_b["step_minutes"]) if in_b else None,
            "status": "compared" if (in_a and in_b) else
                      ("missing_in_b" if in_a else "missing_in_a"),
            "diff_minutes": None,   # 缺项/不可比时保持 None，绝不当 0
        }
        if row["status"] != "compared":
            missing_names.append(f"{row['name']}（仅运行"
                                 f"{'A' if in_a else 'B'}）")
        elif comparable:
            row["diff_minutes"] = (row["b"]["sunlit_minutes"]
                                   - row["a"]["sunlit_minutes"])
        rows.append(row)

    if missing_names:
        issues.append(
            "测点缺失（未计入差值与汇总，缺项不按 0 处理）："
            + "、".join(missing_names))

    # 汇总只覆盖两侧都有的测点
    compared = [r for r in rows if r["status"] == "compared"]
    totals = {
        "points_compared": len(compared),
        "points_missing_in_a": sum(1 for r in rows if r["status"] == "missing_in_a"),
        "points_missing_in_b": sum(1 for r in rows if r["status"] == "missing_in_b"),
        "points_changed": (sum(1 for r in compared if r["diff_minutes"])
                           if comparable else None),
    }

    return {
        "run_a": meta_a, "run_b": meta_b,
        "comparable": comparable,
        "issues": issues,
        "diff_convention": DIFF_CONVENTION,
        "points": rows if comparable else [],
        "totals": totals,
    }
