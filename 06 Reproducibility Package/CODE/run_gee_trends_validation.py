"""Create ET/rainfall trends and independent-product validation in Earth Engine.

The 2018-2023 time series uses the validated 2023 crop map as a fixed spatial
mask, so trends represent hydroclimatic variability over a constant crop extent
rather than annual crop-area change. Primary estimates use WaPOR AETI + CHIRPS;
the independent comparison pathway uses MODIS MOD16A2GF ET + ERA5-Land rainfall.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import ee
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = PROJECT_ROOT / "data" / "processed" / "trends_validation"
EE_PROJECT = "ee-muhammandahmad158609"
ASSET_FOLDER = f"projects/{EE_PROJECT}/assets/indus_vwf_2023"
RABI_CLASS = f"{ASSET_FOLDER}/crop_classification_rabi_2023_30m"
KHARIF_CLASS = f"{ASSET_FOLDER}/crop_classification_kharif_2023_30m"
TABLE_ASSET = f"{ASSET_FOLDER}/crop_water_trends_validation_2018_2023"

CROPS = [
    {"code": 1, "name": "Wheat", "season": "rabi", "start_month": 11, "start_year_offset": -1, "end_month": 5, "end_year_offset": 0, "mask_source": "rabi"},
    {"code": 2, "name": "Rice", "season": "kharif", "start_month": 6, "start_year_offset": 0, "end_month": 11, "end_year_offset": 0, "mask_source": "kharif"},
    {"code": 3, "name": "Cotton", "season": "kharif", "start_month": 4, "start_year_offset": 0, "end_month": 12, "end_year_offset": 0, "mask_source": "kharif"},
    {"code": 4, "name": "Sugarcane", "season": "annual", "start_month": 1, "start_year_offset": 0, "end_month": 1, "end_year_offset": 1, "mask_source": "union"},
    {"code": 5, "name": "Maize", "season": "spring_autumn", "start_month": 2, "start_year_offset": 0, "end_month": 12, "end_year_offset": 0, "mask_source": "union"},
]


def initialize() -> None:
    ee.Initialize(project=EE_PROJECT)


def asset_exists(asset_id: str) -> bool:
    try:
        ee.data.getAsset(asset_id)
        return True
    except ee.EEException:
        return False


def study_geometry() -> ee.Geometry:
    pakistan = ee.FeatureCollection("FAO/GAUL/2015/level0").filter(
        ee.Filter.eq("ADM0_NAME", "Pakistan")
    )
    indus = ee.FeatureCollection("WWF/HydroSHEDS/v1/Basins/hybas_5").filter(
        ee.Filter.eq("MAIN_BAS", 4050033640)
    )
    return indus.geometry().intersection(pakistan.geometry(), ee.ErrorMargin(1000))


def crop_mask(crop: dict, rabi: ee.Image, kharif: ee.Image, study: ee.Geometry) -> ee.Image:
    code = crop["code"]
    if crop["mask_source"] == "rabi":
        result = rabi.eq(code)
    elif crop["mask_source"] == "kharif":
        result = kharif.eq(code)
    else:
        result = rabi.eq(code).Or(kharif.eq(code))
    return result.selfMask().rename("crop_mask").clip(study)


def period(crop: dict, year: int) -> tuple[str, str]:
    start_year = year + crop["start_year_offset"]
    end_year = year + crop["end_year_offset"]
    return f"{start_year:04d}-{crop['start_month']:02d}-01", f"{end_year:04d}-{crop['end_month']:02d}-01"


def wapor_aeti(study: ee.Geometry, start_text: str, end_text: str) -> ee.Image:
    start = ee.Date(start_text)
    end = ee.Date(end_text)

    def integrate(image: ee.Image) -> ee.Image:
        date = ee.Date(image.get("system:time_start"))
        day = ee.Number.parse(date.format("d"))
        month_start = ee.Date.fromYMD(
            ee.Number.parse(date.format("Y")), ee.Number.parse(date.format("M")), 1
        )
        nominal_end = ee.Date(
            ee.Algorithms.If(day.lt(21), date.advance(10, "day"), month_start.advance(1, "month"))
        )
        clipped_start = ee.Date(ee.Algorithms.If(date.millis().lt(start.millis()), start, date))
        clipped_end = ee.Date(ee.Algorithms.If(nominal_end.millis().gt(end.millis()), end, nominal_end))
        days = clipped_end.difference(clipped_start, "day").max(0)
        # WaPOR dekads have different clipped day counts at season edges. Cast
        # every mapped image explicitly so Earth Engine does not infer a
        # different numeric range for otherwise identical float bands.
        return (
            image.select("L1-AETI-D")
            .multiply(0.1)
            .multiply(days)
            .rename("wapor_aeti_mm")
            .toFloat()
        )

    return (
        ee.ImageCollection("FAO/WAPOR/3/L1_AETI_D")
        .filterBounds(study)
        .filterDate(start, end)
        .map(integrate)
        .sum()
        .rename("wapor_aeti_mm")
        .toFloat()
        .clip(study)
    )


def modis_et(study: ee.Geometry, start: str, end: str) -> ee.Image:
    def scale(image: ee.Image) -> ee.Image:
        et = image.select("ET")
        return et.updateMask(et.lt(32700)).multiply(0.1).rename("modis_et_mm").toFloat()

    return (
        ee.ImageCollection("MODIS/061/MOD16A2GF")
        .filterBounds(study)
        .filterDate(start, end)
        .map(scale)
        .sum()
        .rename("modis_et_mm")
        .toFloat()
        .clip(study)
    )


def chirps_rainfall(study: ee.Geometry, start: str, end: str) -> ee.Image:
    return (
        ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY")
        .filterBounds(study)
        .filterDate(start, end)
        .select("precipitation")
        .sum()
        .rename("chirps_rainfall_mm")
        .toFloat()
        .clip(study)
    )


def era5_rainfall(study: ee.Geometry, start: str, end: str) -> ee.Image:
    return (
        ee.ImageCollection("ECMWF/ERA5_LAND/MONTHLY_AGGR")
        .filterBounds(study)
        .filterDate(start, end)
        .select("total_precipitation_sum")
        .sum()
        .multiply(1000)
        .rename("era5_rainfall_mm")
        .toFloat()
        .clip(study)
    )


def effective_rainfall(
    monthly_collection: ee.ImageCollection,
    input_band: str,
    output_name: str,
    study: ee.Geometry,
    start_text: str,
    end_text: str,
    scale_factor: float,
) -> ee.Image:
    start = ee.Date(start_text)
    end = ee.Date(end_text)
    month_count = end.advance(-1, "day").difference(start, "month").floor().add(1)

    def one_month(offset: ee.Number) -> ee.Image:
        month_start = start.advance(ee.Number(offset), "month")
        raw_end = month_start.advance(1, "month")
        month_end = ee.Date(ee.Algorithms.If(raw_end.millis().gt(end.millis()), end, raw_end))
        rainfall = (
            monthly_collection.filterBounds(study)
            .filterDate(month_start, month_end)
            .select(input_band)
            .sum()
            .multiply(scale_factor)
        )
        low = rainfall.multiply(ee.Image.constant(125).subtract(rainfall.multiply(0.2))).divide(125)
        high = rainfall.multiply(0.1).add(125)
        return low.where(rainfall.gt(250), high).max(0).rename(output_name).toFloat()

    return (
        ee.ImageCollection.fromImages(ee.List.sequence(0, month_count.subtract(1)).map(one_month))
        .sum()
        .rename(output_name)
        .toFloat()
        .clip(study)
    )


def one_feature(
    crop: dict,
    year: int,
    mask: ee.Image,
    study: ee.Geometry,
) -> ee.Feature:
    start, end = period(crop, year)
    wapor = wapor_aeti(study, start, end).updateMask(mask)
    modis = modis_et(study, start, end).updateMask(mask)
    chirps = chirps_rainfall(study, start, end).updateMask(mask)
    era5 = era5_rainfall(study, start, end).updateMask(mask)
    chirps_effective = effective_rainfall(
        ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY"),
        "precipitation",
        "chirps_effective_rainfall_mm",
        study,
        start,
        end,
        1.0,
    ).updateMask(mask)
    era5_effective = effective_rainfall(
        ee.ImageCollection("ECMWF/ERA5_LAND/MONTHLY_AGGR"),
        "total_precipitation_sum",
        "era5_effective_rainfall_mm",
        study,
        start,
        end,
        1000.0,
    ).updateMask(mask)

    primary_green = wapor.min(chirps_effective).rename("primary_green_water_mm")
    primary_blue = wapor.subtract(primary_green).max(0).rename("primary_blue_water_mm")
    comparison_green = modis.min(era5_effective).rename("comparison_green_water_mm")
    comparison_blue = modis.subtract(comparison_green).max(0).rename("comparison_blue_water_mm")
    stack = ee.Image.cat(
        [
            wapor,
            modis,
            chirps,
            era5,
            chirps_effective,
            era5_effective,
            primary_green,
            primary_blue,
            primary_blue.divide(wapor).multiply(100).rename("primary_blue_dependency_pct"),
            comparison_green,
            comparison_blue,
            comparison_blue.divide(modis).multiply(100).rename("comparison_blue_dependency_pct"),
        ]
    )
    stats = stack.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=study,
        scale=1000,
        maxPixels=1e9,
        bestEffort=True,
        tileScale=4,
    )
    # Earth Engine table assets require a geometry. The study-area
    # representative point records spatial provenance without implying that
    # the crop-season mean is a point observation.
    return ee.Feature(study.centroid(1000), stats).set(
        {
            "analysis_year": year,
            "crop_code": crop["code"],
            "crop_name": crop["name"],
            "season": crop["season"],
            "start_date": start,
            "end_date_exclusive": end,
            "crop_extent_definition": "fixed validated 2023 Random Forest crop mask",
            "primary_pathway": "WaPOR v3 AETI plus CHIRPS USDA-SCS effective rainfall",
            "comparison_pathway": "MODIS MOD16A2GF ET plus ERA5-Land USDA-SCS effective rainfall",
            "water_depth_units": "mm crop-season-1",
            "geometry_role": "study-area representative point; statistics are masked basin means",
        }
    )


def dataframe_from_asset() -> pd.DataFrame:
    info = ee.FeatureCollection(TABLE_ASSET).getInfo()
    frame = pd.DataFrame([feature["properties"] for feature in info["features"]])
    numeric = [
        column
        for column in frame.columns
        if column.endswith("_mm") or column.endswith("_pct") or column in {"analysis_year", "crop_code"}
    ]
    for column in numeric:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame["et_product_difference_pct"] = (
        (frame["modis_et_mm"] - frame["wapor_aeti_mm"]) / frame["wapor_aeti_mm"] * 100
    )
    frame["rainfall_product_difference_pct"] = (
        (frame["era5_rainfall_mm"] - frame["chirps_rainfall_mm"])
        / frame["chirps_rainfall_mm"]
        * 100
    )
    frame["blue_dependency_pathway_difference_pct_points"] = (
        frame["comparison_blue_dependency_pct"] - frame["primary_blue_dependency_pct"]
    )
    return frame.sort_values(["analysis_year", "crop_code"])


def main() -> None:
    initialize()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if not asset_exists(TABLE_ASSET):
        study = study_geometry()
        rabi = ee.Image(RABI_CLASS).select("crop_class")
        kharif = ee.Image(KHARIF_CLASS).select("crop_class")
        features = []
        for year in range(2018, 2024):
            for crop in CROPS:
                features.append(one_feature(crop, year, crop_mask(crop, rabi, kharif, study), study))
        task = ee.batch.Export.table.toAsset(
            collection=ee.FeatureCollection(features),
            description="Indus_crop_water_trends_validation_2018_2023",
            assetId=TABLE_ASSET,
        )
        task.start()
        print(f"Started {task.id}: {TABLE_ASSET}", flush=True)
        while task.status().get("state") not in {"COMPLETED", "FAILED", "CANCELLED"}:
            print("Trend/validation export:", task.status().get("state"), flush=True)
            time.sleep(30)
        if task.status().get("state") != "COMPLETED":
            raise RuntimeError(task.status())
    frame = dataframe_from_asset()
    output = OUTPUT_DIR / "crop_water_trends_validation_fixed_2023_extent_2018_2023.csv"
    frame.to_csv(output, index=False)
    manifest = {
        "asset": TABLE_ASSET,
        "rows": len(frame),
        "years": sorted(frame["analysis_year"].dropna().astype(int).unique().tolist()),
        "crops": sorted(frame["crop_name"].dropna().unique().tolist()),
        "interpretation": "Hydroclimatic/product trend over fixed 2023 crop extent; not annual crop-map change.",
        "uncertainty_use": "Primary/comparison pathway spread supplies empirical structural sensitivity bounds.",
    }
    (OUTPUT_DIR / "trends_validation_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2), flush=True)


if __name__ == "__main__":
    main()
