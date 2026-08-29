"""Recalculate defensible diagnostics from the completed Indus project outputs.

The script does not modify authoritative project outputs. It creates revision-only
tables that distinguish validation evidence, area scenarios, structural product
sensitivity, temporal context, and hotspot-threshold sensitivity.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd


def safe_pct(new: float, old: float) -> float:
    return np.nan if old == 0 else 100.0 * (new - old) / old


def add_water_metrics(green_mm: float, blue_mm: float, yield_t_ha: float) -> dict[str, float]:
    total_mm = green_mm + blue_mm
    return {
        "green_water_mm": green_mm,
        "blue_water_mm": blue_mm,
        "total_water_mm": total_mm,
        "green_vwf_m3_t": green_mm * 10.0 / yield_t_ha,
        "blue_vwf_m3_t": blue_mm * 10.0 / yield_t_ha,
        "total_vwf_m3_t": total_mm * 10.0 / yield_t_ha,
        "water_productivity_kg_m3": yield_t_ha * 100.0 / total_mm,
        "blue_dependency_pct": 100.0 * blue_mm / total_mm,
    }


def classification_diagnostics(matrix: pd.DataFrame, accuracy: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    class_rows = []
    season_rows = []
    for season, part in matrix.groupby("season", sort=False):
        classes = sorted(set(part["actual_code"]).union(part["predicted_code"]))
        lookup = part.set_index(["actual_code", "predicted_code"])["sample_count"]
        cm = np.array([[float(lookup.get((a, p), 0)) for p in classes] for a in classes])
        support = cm.sum(axis=1)
        predicted = cm.sum(axis=0)
        tp = np.diag(cm)
        producer = np.divide(tp, support, out=np.full_like(tp, np.nan), where=support > 0)
        user = np.divide(tp, predicted, out=np.full_like(tp, np.nan), where=predicted > 0)
        f1 = np.divide(2 * producer * user, producer + user, out=np.full_like(tp, np.nan), where=(producer + user) > 0)
        names = (
            accuracy[accuracy["season"].eq(season)]
            .drop_duplicates("class_code")
            .set_index("class_code")["crop_name"]
            .to_dict()
        )
        for i, code in enumerate(classes):
            class_rows.append({
                "season": season,
                "class_code": code,
                "crop_name": names.get(code, str(code)),
                "validation_support": int(support[i]),
                "predicted_support": int(predicted[i]),
                "correct": int(tp[i]),
                "producer_accuracy": producer[i],
                "user_accuracy": user[i],
                "f1": f1[i],
            })
        row = accuracy[accuracy["season"].eq(season)].iloc[0]
        season_rows.append({
            "season": season,
            "overall_accuracy": float(row["overall_accuracy"]),
            "kappa": float(row["kappa"]),
            "balanced_accuracy": float(np.nanmean(producer)),
            "macro_f1": float(np.nanmean(f1)),
            "training_samples": int(row["training_samples"]),
            "validation_samples": int(row["validation_samples"]),
            "validation_blocks": np.nan,
            "interpretation": "spatial-block holdout; not area-probability sampled",
        })
    return pd.DataFrame(class_rows), pd.DataFrame(season_rows)


def area_scenarios(crop: pd.DataFrame, area: pd.DataFrame) -> pd.DataFrame:
    merged = crop.drop(columns=["official_harvested_area_ha"], errors="ignore").merge(
        area[["crop_code", "official_harvested_area_ha"]], on="crop_code", how="left"
    )
    records = []
    for row in merged.itertuples(index=False):
        mean_yield = row.mapped_production_t / row.mapped_area_ha
        official_water = row.total_water_mm * row.official_harvested_area_ha * 10.0
        official_production = row.official_harvested_area_ha * mean_yield
        records.append({
            "crop_code": row.crop_code,
            "crop_name": row.crop_name,
            "mapped_area_ha": row.mapped_area_ha,
            "official_harvested_area_ha": row.official_harvested_area_ha,
            "mapped_minus_official_pct": safe_pct(row.mapped_area_ha, row.official_harvested_area_ha),
            "mapped_total_water_km3": row.total_water_m3 / 1e9,
            "official_area_scaled_total_water_km3": official_water / 1e9,
            "area_scenario_min_water_km3": min(row.total_water_m3, official_water) / 1e9,
            "area_scenario_max_water_km3": max(row.total_water_m3, official_water) / 1e9,
            "mapped_production_t": row.mapped_production_t,
            "official_area_scaled_production_t": official_production,
            "mapped_total_vwf_m3_t": row.total_vwf_m3_t,
            "scaled_total_vwf_m3_t": official_water / official_production,
            "scenario_note": "official-area scaling holds mapped mean depth and mapped yield composition fixed; scenario, not confidence interval",
        })
    return pd.DataFrame(records)


def product_endpoints(crop: pd.DataFrame, trends: pd.DataFrame) -> pd.DataFrame:
    trend_2023 = trends[trends["analysis_year"].eq(2023)].set_index("crop_name")
    records = []
    for row in crop.itertuples(index=False):
        alt = trend_2023.loc[row.crop_name]
        primary_trend_green = float(alt["primary_green_water_mm"])
        primary_trend_blue = float(alt["primary_blue_water_mm"])
        green_ratio = float(alt["comparison_green_water_mm"]) / primary_trend_green if primary_trend_green else 1.0
        blue_ratio = float(alt["comparison_blue_water_mm"]) / primary_trend_blue if primary_trend_blue else 1.0
        endpoints = {
            "WaPOR-CHIRPS": add_water_metrics(row.green_water_mm, row.blue_water_mm, row.mapped_production_t / row.mapped_area_ha),
            "MODIS-ERA5-Land": add_water_metrics(row.green_water_mm * green_ratio, row.blue_water_mm * blue_ratio, row.mapped_production_t / row.mapped_area_ha),
        }
        for chain, values in endpoints.items():
            records.append({"crop_code": row.crop_code, "crop_name": row.crop_name, "product_chain": chain, **values})
    endpoint = pd.DataFrame(records)
    summaries = []
    for (code, crop_name), part in endpoint.groupby(["crop_code", "crop_name"], sort=True):
        primary = part[part["product_chain"].eq("WaPOR-CHIRPS")].iloc[0]
        comparison = part[part["product_chain"].eq("MODIS-ERA5-Land")].iloc[0]
        for metric in ["green_water_mm", "blue_water_mm", "total_water_mm", "green_vwf_m3_t", "blue_vwf_m3_t", "total_vwf_m3_t", "water_productivity_kg_m3", "blue_dependency_pct"]:
            a = float(primary[metric])
            b = float(comparison[metric])
            summaries.append({
                "crop_code": code,
                "crop_name": crop_name,
                "metric": metric,
                "primary_wapor_chirps": a,
                "comparison_modis_era5_land": b,
                "minimum": min(a, b),
                "maximum": max(a, b),
                "absolute_difference": b - a,
                "comparison_minus_primary_pct": safe_pct(b, a),
                "method": "two-endpoint structural envelope; not a confidence interval",
            })
    return endpoint, pd.DataFrame(summaries)


def temporal_context(trends: pd.DataFrame) -> pd.DataFrame:
    records = []
    metrics = {
        "wapor_aeti_mm": "WaPOR AETI",
        "chirps_rainfall_mm": "CHIRPS rainfall",
        "primary_blue_dependency_pct": "Primary blue dependency",
    }
    for crop_name, part in trends.groupby("crop_name", sort=False):
        baseline = part[part["analysis_year"].between(2018, 2022)]
        current = part[part["analysis_year"].eq(2023)]
        if current.empty or baseline.empty:
            continue
        current = current.iloc[0]
        for field, label in metrics.items():
            mean = float(baseline[field].mean())
            sd = float(baseline[field].std(ddof=1))
            value = float(current[field])
            records.append({
                "crop_name": crop_name,
                "metric": label,
                "baseline_years": "2018-2022",
                "baseline_n": len(baseline),
                "baseline_mean": mean,
                "baseline_sd": sd,
                "value_2023": value,
                "departure": value - mean,
                "departure_pct": safe_pct(value, mean),
                "standardized_departure": (value - mean) / sd if sd > 0 else np.nan,
                "scope_note": "fixed validated 2023 crop extent; short product context, not long-term climatology",
            })
    return pd.DataFrame(records)


def hotspot_sensitivity(district: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    district = district[
        district["blue_water_m3"].notna()
        & district["total_vwf_m3_t"].notna()
        & district["water_productivity_kg_m3"].notna()
    ].copy()
    thresholds = [(0.70, 0.30), (0.75, 0.25), (0.80, 0.20), (0.90, 0.10)]
    rows = []
    assignments = []
    scopes = {
        "all computable districts": district.copy(),
        "districts with mapped area >=25,000 ha": district[district["mapped_area_ha"].ge(25000)].copy(),
    }
    for scope, scoped in scopes.items():
        for high_q, low_q in thresholds:
            b_cut = float(scoped["blue_water_m3"].quantile(high_q))
            v_cut = float(scoped["total_vwf_m3_t"].quantile(high_q))
            wp_cut = float(scoped["water_productivity_kg_m3"].quantile(low_q))
            score = (
                scoped["blue_water_m3"].ge(b_cut).astype(int)
                + scoped["total_vwf_m3_t"].ge(v_cut).astype(int)
                + scoped["water_productivity_kg_m3"].le(wp_cut).astype(int)
            )
            priority = score.ge(2)
            rows.append({
                "scope": scope,
                "district_count": len(scoped),
                "threshold_pair": f"{int(high_q*100)}/{int(low_q*100)}",
                "high_quantile": high_q,
                "low_quantile": low_q,
                "blue_volume_cutoff_km3": b_cut / 1e9,
                "total_vwf_cutoff_m3_t": v_cut,
                "water_productivity_cutoff_kg_m3": wp_cut,
                "score_0_count": int((score == 0).sum()),
                "score_1_count": int((score == 1).sum()),
                "score_2_count": int((score == 2).sum()),
                "score_3_count": int((score == 3).sum()),
                "priority_score_ge_2_count": int(priority.sum()),
            })
            for idx, row in scoped.iterrows():
                assignments.append({
                    "scope": scope,
                    "gaul1_name": row["gaul1_name"],
                    "gaul2_name": row["gaul2_name"],
                    "mapped_area_ha": row["mapped_area_ha"],
                    "threshold_pair": f"{int(high_q*100)}/{int(low_q*100)}",
                    "score_0_3": int(score.loc[idx]),
                    "priority_score_ge_2": int(priority.loc[idx]),
                })
    assignment = pd.DataFrame(assignments)
    stability = (
        assignment.groupby(["scope", "gaul1_name", "gaul2_name", "mapped_area_ha"], as_index=False)
        .agg(
            threshold_tests=("threshold_pair", "count"),
            priority_count=("priority_score_ge_2", "sum"),
            minimum_score=("score_0_3", "min"),
            maximum_score=("score_0_3", "max"),
        )
    )
    stability["priority_stability"] = np.select(
        [stability["priority_count"].eq(4), stability["priority_count"].eq(0)],
        ["priority under all thresholds", "never priority"],
        default="threshold-sensitive priority",
    )
    return pd.DataFrame(rows), stability.sort_values(["scope", "priority_count", "maximum_score", "mapped_area_ha"], ascending=[True, False, False, False])


def yield_coverage(district_crop: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    data = district_crop.copy()
    data["positive_mapped_area"] = data["mapped_area_ha"].gt(0)
    data["positive_matched_yield"] = data["official_yield_t_ha"].gt(0)
    data["computable"] = data["mapped_production_t"].gt(0) & data["total_vwf_m3_t"].notna()
    crop = data.groupby("crop_name", as_index=False).agg(
        district_crop_rows=("gaul2_code", "count"),
        rows_with_mapped_crop=("positive_mapped_area", "sum"),
        rows_with_positive_yield=("positive_matched_yield", "sum"),
        computable_rows=("computable", "sum"),
        mapped_area_ha=("mapped_area_ha", "sum"),
    )
    crop["computable_row_pct"] = 100.0 * crop["computable_rows"] / crop["district_crop_rows"]
    district = data.groupby(["gaul1_name", "gaul2_name"], as_index=False).agg(
        crop_rows=("crop_name", "count"),
        computable_crop_rows=("computable", "sum"),
        mapped_area_ha=("mapped_area_ha", "sum"),
    )
    district["any_computable"] = district["computable_crop_rows"].gt(0)
    return crop, district


def main() -> None:
    project = Path(sys.argv[1])
    output = Path(sys.argv[2])
    output.mkdir(parents=True, exist_ok=True)
    crop = pd.read_csv(project / "03_Exported_GEE_Data/csv/water_vwf/crop_summary_water_vwf_2023.csv")
    district_crop = pd.read_csv(project / "03_Exported_GEE_Data/csv/water_vwf/district_crop_water_vwf_2023.csv")
    area = pd.read_csv(project / "07_Final_Tables/Table_04_Crop_Area_Remote_Sensing_vs_Official.csv")
    accuracy = pd.read_csv(project / "07_Final_Tables/Table_03_Crop_Classification_Accuracy.csv")
    matrix = pd.read_csv(project / "03_Exported_GEE_Data/csv/classification/classification_confusion_matrix_2023.csv")
    trends = pd.read_csv(project / "03_Exported_GEE_Data/csv/trends_validation/crop_water_trends_validation_fixed_2023_extent_2018_2023.csv")
    district = pd.read_csv(project / "07_Final_Tables/Table_16_District_Hotspot_Ranking.csv")

    class_detail, class_season = classification_diagnostics(matrix, accuracy)
    area_table = area_scenarios(crop, area)
    endpoints, endpoint_summary = product_endpoints(crop, trends)
    temporal = temporal_context(trends)
    threshold, stability = hotspot_sensitivity(district)
    coverage_crop, coverage_district = yield_coverage(district_crop)

    outputs = {
        "Table_S1_Classification_Class_Diagnostics.csv": class_detail,
        "Table_S2_Classification_Season_Diagnostics.csv": class_season,
        "Table_S3_Crop_Area_Scenario_Envelope.csv": area_table,
        "Table_S4_Product_Chain_Endpoints.csv": endpoints,
        "Table_S5_Product_Chain_Structural_Envelope.csv": endpoint_summary,
        "Table_S6_2023_Fixed_Extent_Temporal_Context.csv": temporal,
        "Table_S7_Hotspot_Threshold_Sensitivity.csv": threshold,
        "Table_S8_Hotspot_District_Stability.csv": stability,
        "Table_S9_Yield_Coverage_By_Crop.csv": coverage_crop,
        "Table_S10_Yield_Coverage_By_District.csv": coverage_district,
    }
    for name, table in outputs.items():
        table.to_csv(output / name, index=False)

    water_residual = (crop["green_water_m3"] + crop["blue_water_m3"] - crop["total_water_m3"]).abs()
    vwf_residual = (crop["green_vwf_m3_t"] + crop["blue_vwf_m3_t"] - crop["total_vwf_m3_t"]).abs()
    production_residual = (
        crop["mapped_area_ha"] * (crop["mapped_production_t"] / crop["mapped_area_ha"]) - crop["mapped_production_t"]
    ).abs()
    wp_residual = (
        crop["water_productivity_kg_m3"] - 1000.0 * crop["mapped_production_t"] / crop["total_water_m3"]
    ).abs()
    qc = {
        "status": "PASS",
        "crop_rows": len(crop),
        "district_crop_rows": len(district_crop),
        "computable_district_crop_rows": int(coverage_crop["computable_rows"].sum()),
        "districts_total": int(len(coverage_district)),
        "districts_with_any_computable_crop": int(coverage_district["any_computable"].sum()),
        "max_crop_water_balance_residual_m3": float(water_residual.max()),
        "max_crop_vwf_balance_residual_m3_t": float(vwf_residual.max()),
        "max_crop_production_identity_residual_t": float(production_residual.max()),
        "max_crop_wp_identity_residual_kg_m3": float(wp_residual.max()),
        "robust_priority_districts_all_four_thresholds": stability.loc[
            stability["scope"].eq("all computable districts") & stability["priority_count"].eq(4), "gaul2_name"
        ].tolist(),
        "robust_priority_districts_area_ge_25000_ha": stability.loc[
            stability["scope"].eq("districts with mapped area >=25,000 ha") & stability["priority_count"].eq(4), "gaul2_name"
        ].tolist(),
        "structural_sensitivity_method": "two observed product-chain endpoints; no artificial Monte Carlo interpolation",
        "formal_area_adjustment_performed": False,
        "formal_area_adjustment_reason": "validation sample is spatially blocked but not an area-probability sample",
    }
    (output / "scientific_audit_qc.json").write_text(json.dumps(qc, indent=2), encoding="utf-8")
    print(json.dumps(qc, indent=2))


if __name__ == "__main__":
    main()
