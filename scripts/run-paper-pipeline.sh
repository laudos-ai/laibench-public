#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# laibench v1 — Paper Results Pipeline
# ═══════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS DOES:
#   1. Runs the benchmark on a private configured model list
#   2. Generates the leaderboard
#   3. Builds all paper figures (Python + matplotlib)
#   4. Runs error analysis with failure taxonomy
#   5. Runs ablation studies (judge sensitivity, weight sensitivity)
#   6. Produces paper-ready tables and analysis
#
# PREREQUISITES:
#   - Node.js ≥20, Python 3.10+
#   - npm install (in laibench root)
#   - pip install matplotlib seaborn pandas numpy
#   - OPENROUTER_API_KEY set in environment
#
# ESTIMATED COST: Provider-dependent.
# ESTIMATED TIME: Provider-dependent.
#
# USAGE:
#   export OPENROUTER_API_KEY=sk-or-v1-...
#   chmod +x scripts/run-paper-pipeline.sh
#   ./scripts/run-paper-pipeline.sh
#
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")/.."

# ── Configuration ────────────────────────────────────────────────────────────

SUITE="suites/lite-public.pt-BR.json"
SUITE_LABEL="lite-public.pt-BR"
CONCURRENCY="${LAIBENCH_CONCURRENCY:-1}"
JUDGE_MODEL="${LAIBENCH_CANONICAL_JUDGE_MODEL:-deepseek/deepseek-v4-pro}"
RUNS_DIR="runs/paper"
FIGURES_DIR="paper/figures"
ANALYSIS_DIR="paper/analysis"

if [[ -n "${PAPER_MODELS_FILE:-}" ]]; then
  mapfile -t MODELS < <(grep -vE '^\s*(#|$)' "$PAPER_MODELS_FILE")
elif [[ -n "${PAPER_MODELS:-}" ]]; then
  IFS=',' read -r -a MODELS <<< "$PAPER_MODELS"
else
  echo "Set PAPER_MODELS_FILE or PAPER_MODELS before running the paper pipeline." >&2
  exit 1
fi

mkdir -p "$RUNS_DIR" "$FIGURES_DIR" "$ANALYSIS_DIR"

# ── Phase 1: Benchmark Runs ─────────────────────────────────────────────────

echo "═══ PHASE 1: Running benchmark on ${#MODELS[@]} configured models ═══"

for MODEL in "${MODELS[@]}"; do
  SLUG=$(echo "$MODEL" | tr '/' '-')
  OUT="$RUNS_DIR/${SLUG}.json"

  if [[ -f "$OUT" ]]; then
    echo "⏭  Skipping $MODEL — already exists at $OUT"
    continue
  fi

  echo ""
  echo "▶ Running $MODEL..."
  npm run bench -- suite \
    --suite "$SUITE" \
    --provider openrouter \
    --model "$MODEL" \
    --run-name "$SLUG" \
    --concurrency "$CONCURRENCY" \
    --track model \
    --system-type raw-model \
    --entity-type model \
    --entity-name "$MODEL" \
    --comparison-class paper-raw-model \
    --judge-provider openrouter \
    --judge-model "$JUDGE_MODEL" \
    --judge-provider-label hidden \
    --judge-label frontier-blind-v1 \
    --score-mode judge-primary \
    --out "$OUT" || {
      echo "❌ $MODEL failed — continuing"
      continue
    }
done

# Also add laudos.ai engine if run exists
if [[ -f "runs/internal/laudos-ai-ref.json" ]]; then
  cp "runs/internal/laudos-ai-ref.json" "$RUNS_DIR/laudos-ai.json" 2>/dev/null || true
fi

# ── Phase 2: Leaderboard ────────────────────────────────────────────────────

echo ""
echo "═══ PHASE 2: Building leaderboard ═══"

INPUTS=""
for f in "$RUNS_DIR"/*.json; do
  INPUTS="$INPUTS --inputs $f"
done

npm run bench -- leaderboard \
  $INPUTS \
  --out "$RUNS_DIR/leaderboard.json" \
  --markdown "$RUNS_DIR/leaderboard.md"

echo ""
cat "$RUNS_DIR/leaderboard.md"

# ── Phase 3: Generate all figures + analysis ─────────────────────────────────

echo ""
echo "═══ PHASE 3: Generating figures and analysis ═══"

cat > "$ANALYSIS_DIR/generate_paper_assets.py" << 'PYTHON_SCRIPT'
#!/usr/bin/env python3
"""
laibench — Paper Figures & Analysis Generator
Reads all run JSON files from runs/paper/ and produces publication-quality figures.
"""

import json
import os
import sys
from pathlib import Path
from collections import defaultdict

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np

# ── Config ───────────────────────────────────────────────────────────────────

RUNS_DIR = Path("runs/paper")
FIGURES_DIR = Path("paper/figures")
ANALYSIS_DIR = Path("paper/analysis")
FIGURES_DIR.mkdir(parents=True, exist_ok=True)
ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)

DIMS = ["CRIT", "QUAL", "TERM", "GUIDE", "RAG"]
DIM_LABELS = {"CRIT": "Hallucination\nResistance", "QUAL": "Structural\nQuality", "TERM": "Terminology", "GUIDE": "Anatomical\nCoverage", "RAG": "Template\nFidelity"}
DIM_COLORS = {"CRIT": "#E74C3C", "QUAL": "#3498DB", "TERM": "#2ECC71", "GUIDE": "#F39C12", "RAG": "#9B59B6"}

# Clean model labels
def short_name(label):
    replacements = {
        "openai/gpt-5.5": "GPT-5.5",
        "google/gemini-3.1-pro-preview": "Gemini 3.1 Pro",
        "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
        "openai/gpt-5.4-mini": "GPT-5.4 Mini",
        "google/gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite",
        "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
        "laudos.ai": "Laudos.AI Engine",
    }
    return replacements.get(label, label.split("/")[-1])

# ── Load runs ────────────────────────────────────────────────────────────────

def load_runs():
    runs = []
    for f in sorted(RUNS_DIR.glob("*.json")):
        if f.name in ("leaderboard.json", "leaderboard.md"):
            continue
        try:
            data = json.loads(f.read_text())
            if "manifest" in data and "summary" in data:
                runs.append(data)
        except Exception as e:
            print(f"  ⚠ Skipping {f.name}: {e}", file=sys.stderr)
    return runs

runs = load_runs()
if not runs:
    print("❌ No valid run files found in", RUNS_DIR)
    sys.exit(1)

print(f"Loaded {len(runs)} runs")

# Extract structured data
models = []
for run in runs:
    m = run["manifest"]
    s = run["summary"]
    models.append({
        "name": short_name(m.get("modelLabel", "?")),
        "label": m.get("modelLabel", "?"),
        "overall": s["averageOverall"],
        "pass_rate": s["passRate"],
        "strict_pass": s["strictPassRate"],
        "cost": s["totalCostUsd"],
        "latency": s["averageLatencyMs"],
        "dims": s.get("averagePerDim", {}),
        "verdicts": s.get("verdictCounts", {}),
        "results": run.get("results", []),
    })

# Sort by overall descending
models.sort(key=lambda x: x["overall"], reverse=True)

# ── Figure 1: Hero Bar Chart (Overall Score) ────────────────────────────────

print("  Figure 1: Overall scores...")
fig, ax = plt.subplots(figsize=(10, max(5, len(models) * 0.7)))

names = [m["name"] for m in models]
scores = [m["overall"] for m in models]
colors = ["#E74C3C" if s < 60 else "#F39C12" if s < 80 else "#2ECC71" for s in scores]

bars = ax.barh(range(len(names)), scores, color=colors, edgecolor="white", height=0.6)
ax.set_yticks(range(len(names)))
ax.set_yticklabels(names, fontsize=11, fontweight="500")
ax.set_xlabel("Overall Score (%)", fontsize=12)
ax.set_title("laibench — Overall Score by Model", fontsize=14, fontweight="bold", pad=15)
ax.set_xlim(0, 105)
ax.invert_yaxis()
ax.grid(axis="x", alpha=0.3, linestyle="--")
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)

for bar, score in zip(bars, scores):
    ax.text(bar.get_width() + 1, bar.get_y() + bar.get_height() / 2, f"{score:.1f}%",
            va="center", fontsize=10, fontweight="600")

fig.tight_layout()
fig.savefig(FIGURES_DIR / "fig1_overall_scores.pdf", dpi=300, bbox_inches="tight")
fig.savefig(FIGURES_DIR / "fig1_overall_scores.png", dpi=300, bbox_inches="tight")
plt.close(fig)

# ── Figure 2: Radar Chart (Top 5 Per-Dimension) ─────────────────────────────

print("  Figure 2: Radar chart...")
top_n = min(5, len(models))
top_models = models[:top_n]

angles = np.linspace(0, 2 * np.pi, len(DIMS), endpoint=False).tolist()
angles += angles[:1]

fig, ax = plt.subplots(figsize=(8, 8), subplot_kw=dict(polar=True))
radar_colors = ["#E74C3C", "#3498DB", "#2ECC71", "#F39C12", "#9B59B6"]

for i, m in enumerate(top_models):
    values = [m["dims"].get(d, 0) or 0 for d in DIMS]
    values += values[:1]
    color = radar_colors[i % len(radar_colors)]
    ax.plot(angles, values, "o-", linewidth=2, label=m["name"], color=color, markersize=5)
    ax.fill(angles, values, alpha=0.08, color=color)

ax.set_xticks(angles[:-1])
ax.set_xticklabels([DIM_LABELS.get(d, d) for d in DIMS], fontsize=10)
ax.set_ylim(0, 105)
ax.set_title("Per-Dimension Scores (Top 5 Models)", fontsize=13, fontweight="bold", pad=20)
ax.legend(loc="upper right", bbox_to_anchor=(1.35, 1.1), fontsize=9)
ax.grid(True, alpha=0.3)

fig.tight_layout()
fig.savefig(FIGURES_DIR / "fig2_radar_dims.pdf", dpi=300, bbox_inches="tight")
fig.savefig(FIGURES_DIR / "fig2_radar_dims.png", dpi=300, bbox_inches="tight")
plt.close(fig)

# ── Figure 3: Heatmap (Model × Dimension) ───────────────────────────────────

print("  Figure 3: Heatmap...")
fig, ax = plt.subplots(figsize=(8, max(4, len(models) * 0.55)))

matrix = []
for m in models:
    row = [m["dims"].get(d, None) for d in DIMS]
    matrix.append(row)

matrix_np = np.array([[v if v is not None else np.nan for v in row] for row in matrix])
im = ax.imshow(matrix_np, cmap="RdYlGn", aspect="auto", vmin=40, vmax=100)

ax.set_xticks(range(len(DIMS)))
ax.set_xticklabels(DIMS, fontsize=11, fontweight="600")
ax.set_yticks(range(len(models)))
ax.set_yticklabels([m["name"] for m in models], fontsize=10)
ax.set_title("Score Heatmap: Model × Dimension", fontsize=13, fontweight="bold", pad=12)

for i in range(len(models)):
    for j in range(len(DIMS)):
        val = matrix_np[i, j]
        if not np.isnan(val):
            color = "white" if val < 60 else "black"
            ax.text(j, i, f"{val:.0f}", ha="center", va="center", fontsize=9, fontweight="600", color=color)
        else:
            ax.text(j, i, "—", ha="center", va="center", fontsize=9, color="gray")

cbar = plt.colorbar(im, ax=ax, shrink=0.8, pad=0.02)
cbar.set_label("Score (%)", fontsize=10)

fig.tight_layout()
fig.savefig(FIGURES_DIR / "fig3_heatmap.pdf", dpi=300, bbox_inches="tight")
fig.savefig(FIGURES_DIR / "fig3_heatmap.png", dpi=300, bbox_inches="tight")
plt.close(fig)

# ── Figure 4: Cost vs Score (Pareto) ────────────────────────────────────────

print("  Figure 4: Cost-performance Pareto...")
fig, ax = plt.subplots(figsize=(8, 6))

costs = [max(m["cost"], 0.001) for m in models]  # avoid log(0)
overalls = [m["overall"] for m in models]

ax.scatter(costs, overalls, s=120, c=overalls, cmap="RdYlGn", vmin=50, vmax=100, edgecolors="black", linewidths=0.8, zorder=5)

for m, c, o in zip(models, costs, overalls):
    ax.annotate(m["name"], (c, o), textcoords="offset points", xytext=(8, 4), fontsize=8, alpha=0.85)

# Pareto frontier
sorted_by_cost = sorted(zip(costs, overalls, models), key=lambda x: x[0])
pareto_costs, pareto_scores = [], []
best_score = -1
for c, o, _ in sorted_by_cost:
    if o > best_score:
        pareto_costs.append(c)
        pareto_scores.append(o)
        best_score = o

if len(pareto_costs) > 1:
    ax.plot(pareto_costs, pareto_scores, "--", color="gray", alpha=0.5, linewidth=1.5, label="Pareto frontier")

ax.set_xscale("log")
ax.set_xlabel("Total Cost (USD, log scale)", fontsize=12)
ax.set_ylabel("Overall Score (%)", fontsize=12)
ax.set_title("Cost-Performance Trade-off", fontsize=13, fontweight="bold", pad=12)
ax.grid(True, alpha=0.3, linestyle="--")
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
if pareto_costs:
    ax.legend(fontsize=9)

fig.tight_layout()
fig.savefig(FIGURES_DIR / "fig4_pareto.pdf", dpi=300, bbox_inches="tight")
fig.savefig(FIGURES_DIR / "fig4_pareto.png", dpi=300, bbox_inches="tight")
plt.close(fig)

# ── Figure 5: Failure Distribution by Dimension ─────────────────────────────

print("  Figure 5: Failure distribution...")
fig, ax = plt.subplots(figsize=(10, max(4, len(models) * 0.55)))

# For each model, count how many cases FAIL per dimension
dim_fail_rates = {d: [] for d in DIMS}
model_names_for_fig5 = []

for m in models:
    model_names_for_fig5.append(m["name"])
    for d in DIMS:
        if not m["results"]:
            dim_fail_rates[d].append(0)
            continue
        fail_count = 0
        total = 0
        for r in m["results"]:
            det = r.get("detDims", {}).get(d, {})
            if det.get("score") is not None:
                total += 1
                if det.get("verdict") == "FAIL":
                    fail_count += 1
        dim_fail_rates[d].append(fail_count / max(total, 1) * 100)

x = np.arange(len(model_names_for_fig5))
width = 0.15
offsets = np.arange(len(DIMS)) - len(DIMS) / 2 * width + width / 2

for i, d in enumerate(DIMS):
    ax.barh(x + offsets[i], dim_fail_rates[d], width, label=d, color=list(DIM_COLORS.values())[i], alpha=0.85)

ax.set_yticks(x)
ax.set_yticklabels(model_names_for_fig5, fontsize=10)
ax.set_xlabel("Fail Rate (%)", fontsize=12)
ax.set_title("Dimension-Level Fail Rate by Model", fontsize=13, fontweight="bold", pad=12)
ax.legend(loc="lower right", fontsize=9)
ax.invert_yaxis()
ax.grid(axis="x", alpha=0.3, linestyle="--")
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)

fig.tight_layout()
fig.savefig(FIGURES_DIR / "fig5_failure_dist.pdf", dpi=300, bbox_inches="tight")
fig.savefig(FIGURES_DIR / "fig5_failure_dist.png", dpi=300, bbox_inches="tight")
plt.close(fig)

# ── Figure 6: Score by Modality ──────────────────────────────────────────────

print("  Figure 6: Score by modality...")
modality_scores = defaultdict(lambda: defaultdict(list))

for m in models[:5]:  # top 5 only
    for r in m.get("results", []):
        mod = r.get("meta", {}).get("modality", "?")
        if mod in ("CT", "MRI", "US", "XR"):
            modality_scores[m["name"]][mod].append(r.get("combinedOverall", 0))

if modality_scores:
    fig, ax = plt.subplots(figsize=(10, 6))
    modalities = ["CT", "MRI", "US", "XR"]
    x = np.arange(len(modalities))
    width = 0.15
    colors = ["#E74C3C", "#3498DB", "#2ECC71", "#F39C12", "#9B59B6"]

    for i, (name, mod_data) in enumerate(modality_scores.items()):
        means = [np.mean(mod_data.get(mod, [0])) if mod_data.get(mod) else 0 for mod in modalities]
        ax.bar(x + i * width, means, width, label=name, color=colors[i % len(colors)], alpha=0.85)

    ax.set_xticks(x + width * (len(modality_scores) - 1) / 2)
    ax.set_xticklabels(modalities, fontsize=12, fontweight="600")
    ax.set_ylabel("Overall Score (%)", fontsize=12)
    ax.set_title("Performance by Imaging Modality (Top 5 Models)", fontsize=13, fontweight="bold", pad=12)
    ax.legend(fontsize=9)
    ax.grid(axis="y", alpha=0.3, linestyle="--")
    ax.set_ylim(0, 105)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "fig6_modality.pdf", dpi=300, bbox_inches="tight")
    fig.savefig(FIGURES_DIR / "fig6_modality.png", dpi=300, bbox_inches="tight")
    plt.close(fig)

# ── Error Analysis: Failure Taxonomy ─────────────────────────────────────────

print("  Error analysis: failure taxonomy...")

taxonomy = {
    "HALLUCINATION": {"contrast_hallucination": 0, "finding_fabrication": 0, "measurement_invention": 0, "laterality_confusion": 0},
    "STRUCTURAL": {"missing_section": 0, "section_duplication": 0, "format_violation": 0, "title_error": 0},
    "TERMINOLOGY": {"forbidden_term": 0, "forbidden_opener": 0, "crossmodality_vocab": 0},
    "COVERAGE": {"missing_anatomy": 0, "incomplete_findings": 0, "lost_laterality": 0},
    "CLINICAL_SAFETY": {"normal_conclusion_abnormal": 0, "umbrella_phrase": 0, "critical_omission": 0},
}

check_to_taxonomy = {
    "C01": ("HALLUCINATION", "contrast_hallucination"),
    "C02": ("CLINICAL_SAFETY", "umbrella_phrase"),
    "C04": ("STRUCTURAL", "format_violation"),
    "C05": ("CLINICAL_SAFETY", "umbrella_phrase"),
    "C06": ("CLINICAL_SAFETY", "normal_conclusion_abnormal"),
    "C07": ("COVERAGE", "incomplete_findings"),
    "C08": ("CLINICAL_SAFETY", "umbrella_phrase"),
    "Q01": ("STRUCTURAL", "title_error"),
    "Q02": ("STRUCTURAL", "title_error"),
    "Q03": ("STRUCTURAL", "format_violation"),
    "Q04": ("STRUCTURAL", "format_violation"),
    "Q05": ("STRUCTURAL", "missing_section"),
    "Q06": ("STRUCTURAL", "format_violation"),
    "Q07": ("STRUCTURAL", "format_violation"),
    "Q08": ("STRUCTURAL", "missing_section"),
    "Q09": ("STRUCTURAL", "format_violation"),
    "Q10": ("STRUCTURAL", "section_duplication"),
    "Q11": ("STRUCTURAL", "missing_section"),
    "R01": ("STRUCTURAL", "title_error"),
    "R02": ("HALLUCINATION", "laterality_confusion"),
    "R03": ("COVERAGE", "lost_laterality"),
    "R04": ("COVERAGE", "incomplete_findings"),
    "R05": ("COVERAGE", "incomplete_findings"),
}

# Count failures across all models
model_taxonomy = {}
for m in models:
    counts = {cat: defaultdict(int) for cat in taxonomy}
    total_checks = 0
    total_fails = 0
    for r in m.get("results", []):
        for check in r.get("checks", []):
            total_checks += 1
            if not check.get("passed", True):
                total_fails += 1
                check_id = check.get("id", "")
                # Match check ID prefix (C01, C02, Q01, etc.)
                prefix = check_id[:3] if len(check_id) >= 3 else check_id
                if prefix in check_to_taxonomy:
                    cat, subcat = check_to_taxonomy[prefix]
                    counts[cat][subcat] += 1
                # Handle TERM checks (T00, T01, ...)
                elif check_id.startswith("T") and check.get("dim") == "TERM":
                    if "opener" in check.get("name", "").lower() or "opener" in check.get("evidence", "").lower():
                        counts["TERMINOLOGY"]["forbidden_opener"] += 1
                    elif "modality" in check.get("name", "").lower() or "vocabulary" in check.get("name", "").lower():
                        counts["TERMINOLOGY"]["crossmodality_vocab"] += 1
                    else:
                        counts["TERMINOLOGY"]["forbidden_term"] += 1
                elif check_id.startswith("G") and check.get("dim") == "GUIDE":
                    counts["COVERAGE"]["missing_anatomy"] += 1

    model_taxonomy[m["name"]] = {
        "total_checks": total_checks,
        "total_fails": total_fails,
        "fail_rate": total_fails / max(total_checks, 1) * 100,
        "categories": {cat: dict(subs) for cat, subs in counts.items()},
    }

# Write analysis
analysis_output = {
    "models": model_taxonomy,
    "check_mapping": {k: list(v) for k, v in check_to_taxonomy.items()},
}
(ANALYSIS_DIR / "failure_taxonomy.json").write_text(json.dumps(analysis_output, indent=2, ensure_ascii=False))

# ── Main Results Table (LaTeX) ───────────────────────────────────────────────

print("  Generating LaTeX table...")
latex_lines = [
    r"\begin{table}[t]",
    r"\centering",
    r"\caption{Main results on laibench reference suite (49 cases, pt-BR). Overall score is the weighted clinical score under judge-primary scoring; deterministic clinical checks remain gates. Relaxed pass rate includes PASS and PARTIAL verdicts.}",
    r"\label{tab:main-results}",
    r"\small",
    r"\begin{tabular}{lcccccccc}",
    r"\toprule",
    r"Model & Overall & Pass & Relaxed & CRIT & QUAL & TERM & GUIDE & RAG \\",
    r"\midrule",
]
for m in models:
    d = m["dims"]
    def fmt(v):
        return f"{v:.1f}" if v is not None else "—"
    latex_lines.append(
        f"{m['name']} & {m['overall']:.1f} & {m['strict_pass']:.0f}\\% & {m['pass_rate']:.0f}\\% & "
        f"{fmt(d.get('CRIT'))} & {fmt(d.get('QUAL'))} & {fmt(d.get('TERM'))} & {fmt(d.get('GUIDE'))} & {fmt(d.get('RAG'))} \\\\"
    )
latex_lines.extend([
    r"\bottomrule",
    r"\end{tabular}",
    r"\end{table}",
])
(ANALYSIS_DIR / "table_main_results.tex").write_text("\n".join(latex_lines))

# ── Summary Stats ────────────────────────────────────────────────────────────

print("  Writing summary stats...")
summary = {
    "total_models": len(models),
    "total_cases_per_model": len(models[0]["results"]) if models and models[0]["results"] else 0,
    "best_model": models[0]["name"] if models else "?",
    "best_overall": models[0]["overall"] if models else 0,
    "worst_model": models[-1]["name"] if models else "?",
    "worst_overall": models[-1]["overall"] if models else 0,
    "hardest_dimension": min(DIMS, key=lambda d: np.mean([m["dims"].get(d, 0) or 0 for m in models])),
    "easiest_dimension": max(DIMS, key=lambda d: np.mean([m["dims"].get(d, 0) or 0 for m in models])),
    "total_cost_all_runs": sum(m["cost"] for m in models),
    "average_latency_best": models[0]["latency"] if models else 0,
    "models": [{
        "name": m["name"],
        "overall": m["overall"],
        "pass_rate": m["pass_rate"],
        "strict_pass": m["strict_pass"],
        "cost": m["cost"],
        "latency": m["latency"],
        "dims": m["dims"],
    } for m in models],
}
(ANALYSIS_DIR / "summary_stats.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))

print(f"\n═══ DONE ═══")
print(f"  Figures: {FIGURES_DIR}/")
print(f"  Analysis: {ANALYSIS_DIR}/")
print(f"  Best model: {summary['best_model']} ({summary['best_overall']:.1f}%)")
print(f"  Hardest dimension: {summary['hardest_dimension']}")
print(f"  Total cost: ${summary['total_cost_all_runs']:.2f}")

PYTHON_SCRIPT

python3 "$ANALYSIS_DIR/generate_paper_assets.py"

# ── Phase 4: Summary ────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  PIPELINE COMPLETE"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Runs:       $RUNS_DIR/*.json"
echo "  Leaderboard: $RUNS_DIR/leaderboard.md"
echo "  Figures:    $FIGURES_DIR/*.pdf"
echo "  Analysis:   $ANALYSIS_DIR/"
echo "  LaTeX:      $ANALYSIS_DIR/table_main_results.tex"
echo ""
echo "  Next steps:"
echo "    1. Review figures in $FIGURES_DIR/"
echo "    2. Copy $ANALYSIS_DIR/table_main_results.tex into paper"
echo "    3. Review failure taxonomy in $ANALYSIS_DIR/failure_taxonomy.json"
echo "    4. Write narrative sections based on $ANALYSIS_DIR/summary_stats.json"
echo ""
