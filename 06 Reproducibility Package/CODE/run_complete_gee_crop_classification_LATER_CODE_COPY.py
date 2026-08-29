"""Train and export the 2023 Indus Basin seasonal crop classifications.

The models use spatially separated ADB field observations.  Rabi and Kharif
are classified independently so double-cropped fields are represented
correctly.  Predictors combine cloud-masked Sentinel-2 phenology, Landsat 8/9
surface reflectance, Sentinel-1 backscatter, and SRTM terrain.  Outputs are
stored as Earth Engine assets because the user's Google Drive is full.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import ee
import numpy as np
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[2]
EE_PROJECT = "ee-muhammandahmad158609"
ASSET_FOLDER = f"projects/{EE_PROJECT}/assets/indus_vwf_2023"
RABI_SAMPLES = f"{ASSET_FOLDER}/adb_ground_truth_rabi_2023"
KHARIF_SAMPLES = f"{ASSET_FOLDER}/adb_ground_truth_kharif_2023"
OUTPUT_DIR = PROJECT_ROOT / "data" / "processed" / "classification"
YEAR = 2023
EXPORT_SCALE = 30
EXPORT_CRS = "EPSG:32642"
RF_TREES = 300
RF_SEED = 20260709

CLASS_NAMES = {
    1: "Wheat",
    2: "Rice",
    3: "Cotton",
    4: "Sugarcane",
    5: "Maize",
    6: "Other cropland",
}
SEASON_ORDERS = {"Rabi": [1, 4, 5, 6], "Kharif": [2, 3, 4, 5, 6]}


def initialize() -> None:
    ee.Initialize(project=EE_PROJECT)


def asset_exists(asset_id: str) -> bool:
    try:
        ee.data.getAsset(asset_id)
        return True
    except ee.EEException:
        return False


def study_data() -> tuple[ee.Geometry, ee.FeatureCollection, ee.FeatureCollection]:
    pakistan = ee.FeatureCollection("FAO/GAUL/2015/level0").filter(
        ee.Filter.eq("ADM0_NAME", "Pakistan")
    )
    provinces = ee.FeatureCollection("FAO/GAUL/2015/level1").filter(
        ee.Filter.eq("ADM0_NAME", "Pakistan")
    )
    districts = ee.FeatureCollection("FAO/GAUL/2015/level2").filter(
        ee.Filter.eq("ADM0_NAME", "Pakistan")
    )
    indus = ee.FeatureCollection("WWF/HydroSHEDS/v1/Basins/hybas_5").filter(
        ee.Filter.eq("MAIN_BAS", 4050033640)
    )
    study = indus.geometry().intersection(pakistan.geometry(), ee.ErrorMargin(1000))
    return study, provinces.filterBounds(study), districts.filterBounds(study)


def add_indices(reflectance: ee.Image) -> ee.Image:
    blue = reflectance.select("B2")
    green = reflectance.select("B3")
    red = reflectance.select("B4")
    nir = reflectance.select("B8")
    swir1 = reflectance.select("B11")
    ndvi = nir.subtract(red).divide(nir.add(red)).rename("NDVI")
    evi = (
        nir.subtract(red)
        .multiply(2.5)
        .divide(nir.add(red.multiply(6)).subtract(blue.multiply(7.5)).add(1))
        .rename("EVI")
    )
    ndwi = green.subtract(nir).divide(green.add(nir)).rename("NDWI")
    lswi = nir.subtract(swir1).divide(nir.add(swir1)).rename("LSWI")
    savi = nir.subtract(red).multiply(1.5).divide(nir.add(red).add(0.5)).rename("SAVI")
    return reflectance.addBands([ndvi, evi, ndwi, lswi, savi]).toFloat()


def mask_sentinel2(image: ee.Image) -> ee.Image:
    qa = image.select("QA60")
    scl = image.select("SCL")
    qa_mask = qa.bitwiseAnd(1 << 10).eq(0).And(qa.bitwiseAnd(1 << 11).eq(0))
    scl_mask = (
        scl.neq(1)
        .And(scl.neq(3))
        .And(scl.neq(8))
        .And(scl.neq(9))
        .And(scl.neq(10))
        .And(scl.neq(11))
    )
    reflectance = (
        image.select(["B2", "B3", "B4", "B8", "B11", "B12"])
        .multiply(0.0001)
        .updateMask(qa_mask.And(scl_mask))
    )
    return add_indices(reflectance).copyProperties(image, ["system:time_start"])


def sentinel2_collection(study: ee.Geometry) -> ee.ImageCollection:
    return (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(study)
        .filterDate("2022-11-01", "2023-12-01")
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 80))
        .map(mask_sentinel2)
    )


def mask_landsat(image: ee.Image) -> ee.Image:
    qa = image.select("QA_PIXEL")
    clear = qa.bitwiseAnd(int("111111", 2)).eq(0).And(image.select("QA_RADSAT").eq(0))
    reflectance = (
        image.select(["SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7"])
        .multiply(0.0000275)
        .add(-0.2)
        .rename(["B2", "B3", "B4", "B8", "B11", "B12"])
        .updateMask(clear)
    )
    return add_indices(reflectance).copyProperties(image, ["system:time_start"])


def landsat_collection(study: ee.Geometry) -> ee.ImageCollection:
    l8 = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2")
    l9 = ee.ImageCollection("LANDSAT/LC09/C02/T1_L2")
    return (
        l8.merge(l9)
        .filterBounds(study)
        .filterDate("2022-11-01", "2023-12-01")
        .filter(ee.Filter.lt("CLOUD_COVER", 85))
        .map(mask_landsat)
    )


def prefix_bands(image: ee.Image, prefix: str) -> ee.Image:
    names = image.bandNames()
    return image.rename(names.map(lambda name: ee.String(prefix).cat(ee.String(name))))


def period_composite(
    collection: ee.ImageCollection,
    start: str,
    end: str,
    prefix: str,
    bands: list[str],
) -> ee.Image:
    return prefix_bands(collection.filterDate(start, end).median().select(bands), prefix)


def cropland_mask(study: ee.Geometry, s2: ee.ImageCollection) -> ee.Image:
    worldcover = ee.ImageCollection("ESA/WorldCover/v200").first().select("Map")
    worldcover_crop = worldcover.eq(40)
    dw_probability = (
        ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")
        .filterBounds(study)
        .filterDate("2023-01-01", "2024-01-01")
        .select("crops")
        .mean()
    )
    ndvi = s2.select("NDVI")
    ndvi_max = ndvi.max()
    ndvi_min = ndvi.min()
    amplitude = ndvi_max.subtract(ndvi_min)
    dem = ee.Image("USGS/SRTMGL1_003").select("elevation")
    slope = ee.Terrain.slope(dem)
    dynamic_crop = (
        dw_probability.gte(0.40)
        .And(ndvi_max.gte(0.35))
        .And(amplitude.gte(0.12))
        .And(slope.lt(12))
        .And(dem.lt(2500))
    )
    return worldcover_crop.Or(dynamic_crop).selfMask().rename("cropland").clip(study)


def predictor_stack(season: str, study: ee.Geometry) -> tuple[ee.Image, ee.Image, ee.Image]:
    s2 = sentinel2_collection(study)
    ls = landsat_collection(study)
    index_bands = ["NDVI", "EVI", "NDWI", "LSWI", "SAVI"]
    all_bands = ["B2", "B3", "B4", "B8", "B11", "B12"] + index_bands
    if season == "Rabi":
        periods = [
            ("2022-11-01", "2023-01-01", "S2_NovDec_"),
            ("2023-01-01", "2023-03-01", "S2_JanFeb_"),
            ("2023-03-01", "2023-05-01", "S2_MarApr_"),
        ]
        full_start, full_end = "2022-11-01", "2023-05-01"
    else:
        periods = [
            ("2023-05-01", "2023-07-01", "S2_MayJun_"),
            ("2023-07-01", "2023-09-01", "S2_JulAug_"),
            ("2023-09-01", "2023-11-01", "S2_SepOct_"),
            ("2023-11-01", "2023-12-01", "S2_Nov_"),
        ]
        full_start, full_end = "2023-05-01", "2023-12-01"

    period_images: list[ee.Image] = []
    for start, end, prefix in periods:
        period = period_composite(s2, start, end, prefix, index_bands)
        period_images.append(period)

    index_stack = ee.Image.cat(period_images)
    stack = index_stack

    s2_full = period_composite(s2, full_start, full_end, "S2_Full_", all_bands)
    ls_full = period_composite(ls, full_start, full_end, "LS_Full_", all_bands)
    stack = stack.addBands(s2_full).addBands(ls_full)

    s1 = (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filterBounds(study)
        .filterDate(full_start, full_end)
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH"))
        .select(["VV", "VH"])
        .median()
    )
    s1 = s1.addBands(s1.select("VV").subtract(s1.select("VH")).rename("VV_minus_VH"))
    stack = stack.addBands(prefix_bands(s1, "S1_Full_"))

    dem = ee.Image("USGS/SRTMGL1_003").select("elevation").rename("elevation_m")
    slope = ee.Terrain.slope(dem).rename("slope_deg")
    stack = stack.addBands([dem, slope]).toFloat().clip(study).unmask(-0.25)
    mask = cropland_mask(study, s2)
    return stack, index_stack.toFloat().clip(study).unmask(-0.25), mask


def confusion_metrics(matrix: list[list[int]], order: list[int]) -> dict:
    cm = np.asarray(matrix, dtype=float)
    total = cm.sum()
    diagonal = np.diag(cm)
    producer = np.divide(diagonal, cm.sum(axis=1), out=np.zeros_like(diagonal), where=cm.sum(axis=1) > 0)
    user = np.divide(diagonal, cm.sum(axis=0), out=np.zeros_like(diagonal), where=cm.sum(axis=0) > 0)
    f1 = np.divide(2 * producer * user, producer + user, out=np.zeros_like(diagonal), where=(producer + user) > 0)
    return {
        "matrix": cm.astype(int).tolist(),
        "order": order,
        "classes": [CLASS_NAMES[item] for item in order],
        "overall_accuracy": float(diagonal.sum() / total) if total else math.nan,
        "producer_accuracy": producer.tolist(),
        "user_accuracy": user.tolist(),
        "f1": f1.tolist(),
    }


def train_model(
    season: str,
    predictors: ee.Image,
    sampled_asset: str,
) -> tuple[ee.Classifier, dict]:
    bands = predictors.bandNames()
    sampled = ee.FeatureCollection(sampled_asset)
    training = sampled.filter(ee.Filter.eq("split", "training"))
    validation = sampled.filter(ee.Filter.eq("split", "validation"))
    classifier = ee.Classifier.smileRandomForest(
        numberOfTrees=RF_TREES,
        variablesPerSplit=None,
        minLeafPopulation=2,
        bagFraction=0.70,
        maxNodes=None,
        seed=RF_SEED,
    ).train(training, "class_code", bands)

    validated = validation.classify(classifier, "predicted")
    order = SEASON_ORDERS[season]
    error_matrix = validated.errorMatrix("class_code", "predicted", order)
    matrix = error_matrix.array().getInfo()
    metrics = confusion_metrics(matrix, order)
    metrics.update(
        {
            "season": season,
            "year": YEAR,
            "training_sample_count": int(training.size().getInfo()),
            "validation_sample_count": int(validation.size().getInfo()),
            "kappa": float(error_matrix.kappa().getInfo()),
            "rf_trees": RF_TREES,
            "rf_seed": RF_SEED,
            "predictor_count": int(bands.size().getInfo()),
            "predictor_bands": bands.getInfo(),
            "feature_importance": classifier.explain().getInfo().get("importance", {}),
            "validation_design": "independent 0.05-degree spatial blocks",
            "field_source": "ADB/MNFSR/CRS ground truth, CC BY 4.0, DOI 10.5281/zenodo.11047562",
        }
    )
    return classifier, metrics


def start_predictor_sample_export(
    season: str,
    predictors: ee.Image,
    study: ee.Geometry,
) -> tuple[ee.batch.Task | None, str]:
    asset_id = f"{ASSET_FOLDER}/rf_predictor_samples_{season.casefold()}_2023_30m"
    if asset_exists(asset_id):
        print(f"Keeping existing sampled-predictor asset: {asset_id}", flush=True)
        return None, asset_id
    samples_asset = RABI_SAMPLES if season == "Rabi" else KHARIF_SAMPLES
    points = ee.FeatureCollection(samples_asset).filterBounds(study)
    sampled = predictors.sampleRegions(
        collection=points,
        properties=["class_code", "split", "crop_name", "block_id"],
        scale=30,
        geometries=True,
        tileScale=12,
    )
    task = ee.batch.Export.table.toAsset(
        collection=sampled,
        description=f"Indus_RF_predictor_samples_{season}_2023_30m",
        assetId=asset_id,
    )
    task.start()
    print(f"Started {task.id}: {asset_id}", flush=True)
    return task, asset_id


def start_image_export(
    image: ee.Image,
    asset_name: str,
    description: str,
    study: ee.Geometry,
    scale: int,
    pyramiding: str,
) -> ee.batch.Task | None:
    asset_id = f"{ASSET_FOLDER}/{asset_name}"
    if asset_exists(asset_id):
        print(f"Keeping existing asset: {asset_id}", flush=True)
        return None
    task = ee.batch.Export.image.toAsset(
        image=image,
        description=description,
        assetId=asset_id,
        region=study,
        scale=scale,
        crs=EXPORT_CRS,
        maxPixels=1e13,
        pyramidingPolicy={".default": pyramiding},
    )
    task.start()
    print(f"Started {task.id}: {asset_id}", flush=True)
    return task


def wait_for_tasks(
    tasks: list[ee.batch.Task],
    poll_seconds: int = 30,
    label: str = "Earth Engine export",
) -> None:
    if not tasks:
        return
    while True:
        states = [task.status().get("state", "UNKNOWN") for task in tasks]
        print(f"{label} states:", ", ".join(states), flush=True)
        if all(state in {"COMPLETED", "FAILED", "CANCELLED"} for state in states):
            break
        time.sleep(poll_seconds)
    failures = [task.status() for task in tasks if task.status().get("state") != "COMPLETED"]
    if failures:
        raise RuntimeError(f"{label} failed: {failures}")


def write_accuracy_outputs(metrics_by_season: dict[str, dict]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "classification_accuracy_2023.json").write_text(
        json.dumps(metrics_by_season, indent=2), encoding="utf-8"
    )
    rows = []
    matrix_rows = []
    importance_rows = []
    for season, metrics in metrics_by_season.items():
        for idx, class_code in enumerate(metrics["order"]):
            rows.append(
                {
                    "year": YEAR,
                    "season": season,
                    "class_code": class_code,
                    "crop_name": CLASS_NAMES[class_code],
                    "producer_accuracy": metrics["producer_accuracy"][idx],
                    "user_accuracy": metrics["user_accuracy"][idx],
                    "f1": metrics["f1"][idx],
                    "overall_accuracy": metrics["overall_accuracy"],
                    "kappa": metrics["kappa"],
                    "training_samples": metrics["training_sample_count"],
                    "validation_samples": metrics["validation_sample_count"],
                }
            )
        for i, actual in enumerate(metrics["order"]):
            for j, predicted in enumerate(metrics["order"]):
                matrix_rows.append(
                    {
                        "year": YEAR,
                        "season": season,
                        "actual_code": actual,
                        "actual_crop": CLASS_NAMES[actual],
                        "predicted_code": predicted,
                        "predicted_crop": CLASS_NAMES[predicted],
                        "sample_count": metrics["matrix"][i][j],
                    }
                )
        for band, importance in metrics["feature_importance"].items():
            importance_rows.append(
                {"year": YEAR, "season": season, "predictor": band, "importance": importance}
            )
    pd.DataFrame(rows).to_csv(OUTPUT_DIR / "classification_accuracy_by_crop_2023.csv", index=False)
    pd.DataFrame(matrix_rows).to_csv(OUTPUT_DIR / "classification_confusion_matrix_2023.csv", index=False)
    pd.DataFrame(importance_rows).sort_values(
        ["season", "importance"], ascending=[True, False]
    ).to_csv(OUTPUT_DIR / "classification_feature_importance_2023.csv", index=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-exports", action="store_true")
    parser.add_argument("--no-wait", action="store_true")
    parser.add_argument(
        "--include-display-assets",
        action="store_true",
        help="Also export lower-resolution index, cropland, and dominant display assets.",
    )
    args = parser.parse_args()
    initialize()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    study, _, _ = study_data()

    products: dict[str, dict] = {}
    metrics_by_season: dict[str, dict] = {}
    common_mask: ee.Image | None = None
    sample_tasks: list[ee.batch.Task] = []
    for season in ("Rabi", "Kharif"):
        print(f"Building {season} predictors", flush=True)
        predictors, index_stack, mask = predictor_stack(season, study)
        if common_mask is None:
            common_mask = mask
        sample_task, sampled_asset = start_predictor_sample_export(season, predictors, study)
        if sample_task:
            sample_tasks.append(sample_task)
        products[season] = {
            "predictors": predictors,
            "indices": index_stack,
            "mask": mask,
            "sampled_asset": sampled_asset,
        }

    wait_for_tasks(sample_tasks, label="Predictor-sample export")

    for season in ("Rabi", "Kharif"):
        predictors = products[season]["predictors"]
        index_stack = products[season]["indices"]
        mask = products[season]["mask"]
        print(f"Sampling and training {season} Random Forest", flush=True)
        classifier, metrics = train_model(
            season, predictors, products[season]["sampled_asset"]
        )
        metrics_by_season[season] = metrics
        print(
            f"{season}: OA={metrics['overall_accuracy']:.4f}, "
            f"kappa={metrics['kappa']:.4f}, train={metrics['training_sample_count']}, "
            f"validation={metrics['validation_sample_count']}",
            flush=True,
        )
        classified = (
            predictors.classify(classifier)
            .rename("crop_class")
            .toByte()
            .updateMask(mask)
            .clip(study)
            .set(
                {
                    "analysis_year": YEAR,
                    "season": season,
                    "units": "class_code",
                    "classes": json.dumps(CLASS_NAMES),
                    "field_source_doi": "10.5281/zenodo.11047562",
                    "validation_design": "0.05-degree spatial-block holdout",
                }
            )
        )
        products[season]["classified"] = classified
        products[season]["indices"] = index_stack.set(
            {
                "analysis_year": YEAR,
                "season": season,
                "units": "unitless indices",
                "indices": "NDVI,EVI,NDWI,LSWI,SAVI",
            }
        )

    write_accuracy_outputs(metrics_by_season)
    if args.skip_exports:
        return

    tasks: list[ee.batch.Task] = []
    for season in ("Rabi", "Kharif"):
        tag = season.casefold()
        task = start_image_export(
            products[season]["classified"],
            f"crop_classification_{tag}_2023_30m",
            f"Indus_crop_classification_{season}_2023_30m",
            study,
            EXPORT_SCALE,
            "mode",
        )
        if task:
            tasks.append(task)
        if args.include_display_assets:
            task = start_image_export(
                products[season]["indices"],
                f"seasonal_indices_{tag}_2023_250m",
                f"Indus_seasonal_indices_{season}_2023_250m",
                study,
                250,
                "mean",
            )
            if task:
                tasks.append(task)

    if args.include_display_assets:
        assert common_mask is not None
        task = start_image_export(
            common_mask.toByte().set(
                {
                    "analysis_year": YEAR,
                    "units": "binary 1=cropland",
                    "sources": "ESA WorldCover 2021; Dynamic World 2023; Sentinel-2 phenology; SRTM",
                }
            ),
            "cropland_mask_2023_100m",
            "Indus_cropland_mask_2023_100m",
            study,
            100,
            "mode",
        )
        if task:
            tasks.append(task)

        rabi = products["Rabi"]["classified"]
        kharif = products["Kharif"]["classified"]
        # Kharif is shown where a target Kharif crop is present; otherwise the
        # Rabi target class is retained. Seasonal assets remain authoritative.
        annual = kharif.where(kharif.eq(6).And(rabi.neq(6)), rabi).rename("crop_class")
        annual = annual.updateMask(annual.neq(6)).set(
            {
                "analysis_year": YEAR,
                "units": "class_code",
                "definition": "Kharif-dominant display; use seasonal assets for accounting",
                "classes": json.dumps(CLASS_NAMES),
            }
        )
        task = start_image_export(
            annual,
            "crop_classification_dominant_2023_100m",
            "Indus_crop_classification_dominant_2023_100m",
            study,
            100,
            "mode",
        )
        if task:
            tasks.append(task)

    if not args.no_wait:
        wait_for_tasks(tasks, label="Classification image export")


if __name__ == "__main__":
    main()
