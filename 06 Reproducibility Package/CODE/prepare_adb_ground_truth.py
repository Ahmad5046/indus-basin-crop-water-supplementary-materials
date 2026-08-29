"""Prepare ADB Pakistan crop ground-truth points for Earth Engine.

The source workbook contains field observations from Rabi 2022-23 and
Kharif 2023.  This script preserves the original workbook, normalizes only
unambiguous crop labels, creates an explicit Other-cropland class, removes
duplicate coordinates, and assigns entire 0.05-degree spatial blocks to
training or validation.  A block never appears in both splits.

Source: Asian Development Bank / MNFSR / provincial Crop Reporting Services
DOI: https://doi.org/10.5281/zenodo.11047562
License: CC BY 4.0
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SOURCE = (
    PROJECT_ROOT
    / "data"
    / "raw"
    / "downloaded_sources"
    / "crop_training_references"
    / "ADB_Pakistan_Ground_Truth_2022_2023"
    / "Pakistan_Agricultural_Ground_Truthing_Survey_Data_2022-2023.xlsx"
)
OUTPUT_DIR = PROJECT_ROOT / "data" / "processed" / "training"
BLOCK_DEGREES = 0.05
RANDOM_SEED = 20230709

# Class codes are stable across every GEE and post-processing script.
CLASS_CODES = {
    "Wheat": 1,
    "Rice": 2,
    "Cotton": 3,
    "Sugarcane": 4,
    "Maize": 5,
    "Other cropland": 6,
}

EXACT_TARGET_LABELS = {
    "wheat": "Wheat",
    "rice": "Rice",
    "cotton": "Cotton",
    "sugarcane": "Sugarcane",
    "maize": "Maize",
    "maize (corn)": "Maize",
}

SEASON_CLASSES = {
    "Rabi": ["Wheat", "Sugarcane", "Maize", "Other cropland"],
    "Kharif": ["Rice", "Cotton", "Sugarcane", "Maize", "Other cropland"],
}

# Balanced caps keep GEE sampling computationally tractable while retaining
# thousands of independent field observations per common class.
TRAIN_CAP = 5000
VALIDATION_CAP = 1500


def normalized_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value).strip()).casefold()


def spatial_block(longitude: float, latitude: float) -> str:
    x = int(np.floor((longitude + 180.0) / BLOCK_DEGREES))
    y = int(np.floor((latitude + 90.0) / BLOCK_DEGREES))
    return f"{x}_{y}"


def split_for_block(block_id: str) -> str:
    digest = hashlib.sha256(f"{RANDOM_SEED}:{block_id}".encode("ascii")).hexdigest()
    return "validation" if int(digest[:8], 16) % 5 == 0 else "training"


def classify_row(row: pd.Series) -> str | None:
    description = normalized_text(row["Description"])
    exact = EXACT_TARGET_LABELS.get(description)
    if exact:
        return exact

    land = normalized_text(row["Land"])
    contains_target = any(
        re.search(pattern, description)
        for pattern in (r"\bwheat\b", r"\brice\b", r"\bcotton\b", r"sugar\s*cane", r"\bmaize\b", r"\bcorn\b")
    )
    if land in {"cropland", "fallowland"} and not contains_target:
        return "Other cropland"
    return None


def balanced_sample(frame: pd.DataFrame) -> pd.DataFrame:
    selected: list[pd.DataFrame] = []
    for season, class_names in SEASON_CLASSES.items():
        for class_name in class_names:
            subset = frame[(frame["season"] == season) & (frame["crop_name"] == class_name)]
            for split, cap in (("training", TRAIN_CAP), ("validation", VALIDATION_CAP)):
                group = subset[subset["split"] == split]
                if len(group) > cap:
                    seed = RANDOM_SEED + CLASS_CODES[class_name] * 100 + (0 if split == "training" else 1)
                    group = group.sample(cap, random_state=seed)
                selected.append(group)
    return pd.concat(selected, ignore_index=True).sort_values(
        ["season", "class_code", "split", "sample_id"]
    )


def main() -> None:
    if not SOURCE.exists():
        raise FileNotFoundError(f"ADB workbook is missing: {SOURCE}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    source = pd.read_excel(SOURCE, sheet_name="Sheet1")
    required = {
        "ID", "Season", "Province", "District", "Date", "Latitude",
        "Longitude", "Land", "Description", "Stage",
    }
    missing = required.difference(source.columns)
    if missing:
        raise ValueError(f"ADB workbook is missing columns: {sorted(missing)}")

    work = source.copy()
    work["crop_name"] = work.apply(classify_row, axis=1)
    work = work[work["crop_name"].notna()].copy()
    work = work[work["Season"].isin(SEASON_CLASSES)].copy()
    work = work[
        work["Latitude"].between(23.0, 38.0)
        & work["Longitude"].between(60.0, 78.0)
    ].copy()
    work = work[
        work.apply(lambda r: r["crop_name"] in SEASON_CLASSES[r["Season"]], axis=1)
    ].copy()

    # Exact duplicate coordinates in the same season are redundant for
    # pixel sampling.  Conflicting labels at one coordinate are excluded.
    duplicate_key = ["Season", "Latitude", "Longitude"]
    conflicts = (
        work.groupby(duplicate_key)["crop_name"].nunique().rename("n_labels").reset_index()
    )
    conflicts = conflicts[conflicts["n_labels"] > 1][duplicate_key]
    if not conflicts.empty:
        conflict_index = pd.MultiIndex.from_frame(conflicts)
        row_index = pd.MultiIndex.from_frame(work[duplicate_key])
        work = work[~row_index.isin(conflict_index)].copy()
    work = work.drop_duplicates(duplicate_key + ["crop_name"], keep="first")

    work["block_id"] = [
        spatial_block(lon, lat)
        for lon, lat in zip(work["Longitude"], work["Latitude"], strict=True)
    ]
    work["split"] = work["block_id"].map(split_for_block)
    work["class_code"] = work["crop_name"].map(CLASS_CODES).astype("int16")

    clean = pd.DataFrame(
        {
            "sample_id": work["ID"].astype(str),
            "season": work["Season"].astype(str),
            "province": work["Province"].astype(str),
            "district": work["District"].astype(str),
            "survey_date": work["Date"].astype(str),
            "latitude": work["Latitude"].astype(float),
            "longitude": work["Longitude"].astype(float),
            "class_code": work["class_code"].astype(int),
            "crop_name": work["crop_name"].astype(str),
            "split": work["split"].astype(str),
            "block_id": work["block_id"].astype(str),
            "original_land": work["Land"].astype(str),
            "original_description": work["Description"].astype(str),
            "growth_stage": work["Stage"].fillna("").astype(str),
            "source_doi": "https://doi.org/10.5281/zenodo.11047562",
        }
    )

    selected = balanced_sample(clean)
    clean_path = OUTPUT_DIR / "adb_crop_samples_2023_all_clean.csv"
    selected_path = OUTPUT_DIR / "adb_crop_samples_2023_balanced_gee.csv"
    counts_path = OUTPUT_DIR / "adb_crop_samples_2023_class_counts.csv"
    qc_path = OUTPUT_DIR / "adb_crop_samples_2023_qc.json"

    clean.to_csv(clean_path, index=False)
    selected.to_csv(selected_path, index=False)
    counts = (
        selected.groupby(["season", "class_code", "crop_name", "split"], as_index=False)
        .agg(sample_count=("sample_id", "size"), spatial_blocks=("block_id", "nunique"))
    )
    counts.to_csv(counts_path, index=False)

    train_blocks = set(selected.loc[selected["split"] == "training", "block_id"])
    validation_blocks = set(selected.loc[selected["split"] == "validation", "block_id"])
    overlap = sorted(train_blocks.intersection(validation_blocks))
    qc = {
        "source_file": str(SOURCE),
        "source_rows": int(len(source)),
        "clean_rows": int(len(clean)),
        "balanced_rows": int(len(selected)),
        "spatial_block_degrees": BLOCK_DEGREES,
        "random_seed": RANDOM_SEED,
        "training_blocks": len(train_blocks),
        "validation_blocks": len(validation_blocks),
        "block_overlap_count": len(overlap),
        "class_codes": CLASS_CODES,
        "license": "CC BY 4.0",
        "source_doi": "https://doi.org/10.5281/zenodo.11047562",
        "md5_expected": "fcf7253ad8ac8dced7c091cd14c8a124",
        "status": "PASS" if not overlap and not selected.empty else "FAIL",
    }
    qc_path.write_text(json.dumps(qc, indent=2), encoding="utf-8")

    print(counts.to_string(index=False))
    print(json.dumps(qc, indent=2))
    print(f"GEE upload CSV: {selected_path}")


if __name__ == "__main__":
    main()
