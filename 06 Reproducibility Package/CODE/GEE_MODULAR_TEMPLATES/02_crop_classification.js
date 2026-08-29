// 02_crop_classification.js
// Sentinel-2 + Landsat preprocessing, seasonal composites, spectral indices,
// crop calendar feature stack, Random Forest crop classification, and exports.
//
// This script does not invent training data. Set USE_TRAINING_ASSET = true only
// after uploading validated crop training/validation samples to Earth Engine.

// ============================= USER SETTINGS ==============================
var RUN_EXPORTS = false;
var USE_VALIDATED_CLASSIFICATION_ASSETS = true;
var USE_TRAINING_ASSET = false;  // Set true only to retrain the optional unified model below.
var TRAINING_RABI_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/adb_ground_truth_rabi_2023';
var TRAINING_KHARIF_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/adb_ground_truth_kharif_2023';
var RABI_CLASSIFICATION_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/crop_classification_rabi_2023_30m';
var KHARIF_CLASSIFICATION_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/crop_classification_kharif_2023_30m';
var CROPLAND_MASK_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/cropland_mask_2023_100m';
var GAUL2024_DISTRICTS_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/fao_gaul_2024_pak_adm2_karachi_aggregate';
var KARACHI_COMPONENT_CODES = ['130204', '130206', '130214', '130216', '130223', '130231'];
var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var CLASSIFICATION_YEAR = 2023;
var ANALYSIS_CRS = 'EPSG:32642';
var CROP_SCALE_M = 30;
var TABLE_SCALE_M = 250;
var INDUS_MAIN_BAS = 4050033640;

// Training sample schema expected:
// sample_id, class_code, crop_name, split ('training'/'validation'), source, year.
var CLASS_PROPERTY = 'class_code';
var SPLIT_PROPERTY = 'split';
var RF_TREES = 300;
var RF_SEED = 20260709;

// Crop calendar windows are editable. startYearOffset/endYearOffset are
// relative to CLASSIFICATION_YEAR.
var CROPS = [
  {code: 1, name: 'Wheat', season: 'rabi', startMonth: 11, startDay: 1, startYearOffset: -1, endMonth: 4, endDay: 30, endYearOffset: 0},
  {code: 2, name: 'Rice', season: 'kharif', startMonth: 6, startDay: 1, startYearOffset: 0, endMonth: 10, endDay: 31, endYearOffset: 0},
  {code: 3, name: 'Cotton', season: 'kharif', startMonth: 4, startDay: 1, startYearOffset: 0, endMonth: 11, endDay: 30, endYearOffset: 0},
  {code: 4, name: 'Sugarcane', season: 'annual', startMonth: 1, startDay: 1, startYearOffset: 0, endMonth: 12, endDay: 31, endYearOffset: 0},
  {code: 5, name: 'Maize', season: 'spring_autumn', startMonth: 2, startDay: 1, startYearOffset: 0, endMonth: 11, endDay: 30, endYearOffset: 0}
];

// Predictor windows can be edited without changing crop labels.
var FEATURE_WINDOWS = [
  {key: 'wheat_rabi', startMonth: 11, startDay: 1, startYearOffset: -1, endMonth: 4, endDay: 30, endYearOffset: 0},
  {key: 'rice_peak', startMonth: 7, startDay: 1, startYearOffset: 0, endMonth: 9, endDay: 30, endYearOffset: 0},
  {key: 'cotton_peak', startMonth: 6, startDay: 1, startYearOffset: 0, endMonth: 10, endDay: 31, endYearOffset: 0},
  {key: 'sugarcane_annual', startMonth: 1, startDay: 1, startYearOffset: 0, endMonth: 12, endDay: 31, endYearOffset: 0},
  {key: 'maize_main', startMonth: 2, startDay: 1, startYearOffset: 0, endMonth: 11, endDay: 30, endYearOffset: 0}
];

// ============================= STUDY AREA/MASK ============================
var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0').filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var districts = ee.FeatureCollection(GAUL2024_DISTRICTS_ASSET)
  .filter(ee.Filter.inList('gaul2_code', KARACHI_COMPONENT_CODES).not());
var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');
var studyArea = hydro5.filter(ee.Filter.eq('MAIN_BAS', INDUS_MAIN_BAS)).geometry()
  .intersection(pakistan.geometry(), ee.ErrorMargin(1000));
var studyDistricts = districts.filterBounds(studyArea);
var croplandMask = ee.Image(CROPLAND_MASK_ASSET).select('cropland').selfMask().clip(studyArea);

// ======================== SENSOR PREPROCESSING/CLOUDS ======================
function maskS2sr(image) {
  var scl = image.select('SCL');
  var sclMask = scl.neq(3).and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
  var qa = image.select('QA60');
  var qaMask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0));
  var optical = image.select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'])
    .divide(10000)
    .rename(['blue', 'green', 'red', 'nir', 'swir1', 'swir2']);
  return optical.updateMask(sclMask).updateMask(qaMask)
    .copyProperties(image, ['system:time_start']);
}

function maskLandsatC2L2(image) {
  var qa = image.select('QA_PIXEL');
  var clear = qa.bitwiseAnd(1 << 0).eq(0)  // fill
    .and(qa.bitwiseAnd(1 << 1).eq(0))      // dilated cloud
    .and(qa.bitwiseAnd(1 << 2).eq(0))      // cirrus
    .and(qa.bitwiseAnd(1 << 3).eq(0))      // cloud
    .and(qa.bitwiseAnd(1 << 4).eq(0))      // cloud shadow
    .and(qa.bitwiseAnd(1 << 5).eq(0));     // snow
  var saturation = image.select('QA_RADSAT').eq(0);
  var optical = image.select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'])
    .multiply(0.0000275).add(-0.2)
    .rename(['blue', 'green', 'red', 'nir', 'swir1', 'swir2']);
  return optical.updateMask(clear).updateMask(saturation)
    .copyProperties(image, ['system:time_start']);
}

function addIndices(image) {
  var ndvi = image.normalizedDifference(['nir', 'red']).rename('NDVI');
  var ndwi = image.normalizedDifference(['green', 'nir']).rename('NDWI');
  var lswi = image.normalizedDifference(['nir', 'swir1']).rename('LSWI');
  var evi = image.expression('2.5*((NIR-RED)/(NIR+6*RED-7.5*BLUE+1))', {
    NIR: image.select('nir'), RED: image.select('red'), BLUE: image.select('blue')
  }).rename('EVI');
  var savi = image.expression('1.5*((NIR-RED)/(NIR+RED+0.5))', {
    NIR: image.select('nir'), RED: image.select('red')
  }).rename('SAVI');
  return image.addBands([ndvi, evi, ndwi, lswi, savi]);
}

function datesFromWindow(year, window) {
  var start = ee.Date.fromYMD(year + window.startYearOffset, window.startMonth, window.startDay);
  var end = ee.Date.fromYMD(year + window.endYearOffset, window.endMonth, window.endDay).advance(1, 'day');
  return {start: start, end: end};
}

function sentinelCollection(start, end) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(studyArea)
    .filterDate(start, end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 75))
    .map(maskS2sr)
    .map(addIndices);
}

function landsatCollection(start, end) {
  var l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2').filterBounds(studyArea).filterDate(start, end);
  var l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2').filterBounds(studyArea).filterDate(start, end);
  return l8.merge(l9).map(maskLandsatC2L2).map(addIndices);
}

function compositeForWindow(year, window, sensorName) {
  var d = datesFromWindow(year, window);
  var ic = sensorName === 's2' ? sentinelCollection(d.start, d.end) : landsatCollection(d.start, d.end);
  var bands = ['NDVI', 'EVI', 'NDWI', 'LSWI', 'SAVI'];
  var median = ic.select(bands).median();
  var p = ic.select('NDVI').reduce(ee.Reducer.percentile([10, 90]));
  var image = median.addBands(p);
  var oldNames = ['NDVI', 'EVI', 'NDWI', 'LSWI', 'SAVI', 'NDVI_p10', 'NDVI_p90'];
  var newNames = oldNames.map(function(name) {
    return sensorName + '_' + window.key + '_' + name;
  });
  return image.rename(newNames).toFloat()
    .set({
      sensor: sensorName,
      window: window.key,
      start_date: d.start.format('YYYY-MM-dd'),
      end_date: d.end.advance(-1, 'day').format('YYYY-MM-dd')
    });
}

function buildPredictorStack(year) {
  var stack = ee.Image(0).rename('constant').updateMask(croplandMask);
  FEATURE_WINDOWS.forEach(function(window) {
    stack = stack.addBands(compositeForWindow(year, window, 's2'));
    stack = stack.addBands(compositeForWindow(year, window, 'landsat'));
  });
  return stack.select(stack.bandNames().remove('constant'))
    .updateMask(croplandMask)
    .clip(studyArea)
    .set({
      year: year,
      unit: 'spectral indices',
      source: 'Sentinel-2 SR Harmonized and Landsat 8/9 Collection 2 Level 2',
      notes: 'Predictor stack for Random Forest crop classification.'
    });
}

// =============================== TEMPLATES =================================
function trainingTemplate() {
  return ee.FeatureCollection(CROPS.map(function(crop) {
    return ee.Feature(null, {
      sample_id: 'EXAMPLE_DELETE_' + crop.name,
      class_code: crop.code,
      crop_name: crop.name,
      season: crop.season,
      split: 'training_or_validation',
      year: CLASSIFICATION_YEAR,
      source: 'replace_with_field_or_official_source',
      source_date: 'YYYY-MM-DD',
      confidence: '',
      notes: 'Upload real point/polygon samples as a GEE table asset before classification.'
    });
  }));
}

// ============================= CLASSIFICATION ==============================
var predictors = buildPredictorStack(CLASSIFICATION_YEAR);
print('Predictor bands', predictors.bandNames());
Map.centerObject(studyArea, 6);
Map.addLayer(predictors.select('s2_wheat_rabi_NDVI'), {min: 0, max: 0.8, palette: ['f7f7d2', '74c476', '00441b']}, 'S2 wheat/rabi NDVI predictor', false);
Map.addLayer(croplandMask, {palette: ['74a57f']}, 'ESA WorldCover cropland mask', false);

if (USE_VALIDATED_CLASSIFICATION_ASSETS) {
  var validatedRabiMap = ee.Image(RABI_CLASSIFICATION_ASSET).select('crop_class');
  var validatedKharifMap = ee.Image(KHARIF_CLASSIFICATION_ASSET).select('crop_class');
  var classPalette = ['d9b44a', '4daf4a', 'e41a1c', '984ea3', 'ff7f00', 'bdbdbd'];
  Map.addLayer(validatedRabiMap, {min: 1, max: 6, palette: classPalette}, 'Validated RF crop classification - Rabi 2023', true);
  Map.addLayer(validatedKharifMap, {min: 1, max: 6, palette: classPalette}, 'Validated RF crop classification - Kharif 2023', false);
  print('Validated Rabi asset', RABI_CLASSIFICATION_ASSET);
  print('Validated Kharif asset', KHARIF_CLASSIFICATION_ASSET);
  print('Independent spatial-block validation: Rabi OA 0.8539, kappa 0.7879; Kharif OA 0.8497, kappa 0.8106.');

  if (RUN_EXPORTS) {
    Export.image.toDrive({
      image: validatedRabiMap,
      description: 'map_crop_classification_RF_rabi_2023_unit_crop_code_30m',
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'map_crop_classification_RF_rabi_2023_unit_crop_code_30m',
      region: studyArea,
      scale: CROP_SCALE_M,
      crs: ANALYSIS_CRS,
      maxPixels: 1e13
    });
    Export.image.toDrive({
      image: validatedKharifMap,
      description: 'map_crop_classification_RF_kharif_2023_unit_crop_code_30m',
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'map_crop_classification_RF_kharif_2023_unit_crop_code_30m',
      region: studyArea,
      scale: CROP_SCALE_M,
      crs: ANALYSIS_CRS,
      maxPixels: 1e13
    });
  }
} else if (USE_TRAINING_ASSET) {
  var samples = ee.FeatureCollection(TRAINING_RABI_ASSET)
    .merge(ee.FeatureCollection(TRAINING_KHARIF_ASSET))
    .filterBounds(studyArea);
  var trainingSamples = samples.filter(ee.Filter.eq(SPLIT_PROPERTY, 'training'));
  var validationSamples = samples.filter(ee.Filter.eq(SPLIT_PROPERTY, 'validation'));

  var training = predictors.sampleRegions({
    collection: trainingSamples,
    properties: [CLASS_PROPERTY, 'crop_name', SPLIT_PROPERTY, 'source'],
    scale: CROP_SCALE_M,
    geometries: true,
    tileScale: 4
  });

  var classifier = ee.Classifier.smileRandomForest({
    numberOfTrees: RF_TREES,
    minLeafPopulation: 2,
    bagFraction: 0.7,
    seed: RF_SEED
  }).train({
    features: training,
    classProperty: CLASS_PROPERTY,
    inputProperties: predictors.bandNames()
  });

  var cropMap = predictors.classify(classifier)
    .rename('crop_code')
    .updateMask(croplandMask)
    .clip(studyArea)
    .set({
      year: CLASSIFICATION_YEAR,
      unit: 'crop_code',
      class_1: 'Wheat',
      class_2: 'Rice',
      class_3: 'Cotton',
      class_4: 'Sugarcane',
      class_5: 'Maize',
      class_6: 'Other cropland',
      classifier: 'smileRandomForest',
      number_of_trees: RF_TREES,
      training_assets: TRAINING_RABI_ASSET + '; ' + TRAINING_KHARIF_ASSET
    });

  var validation = predictors.sampleRegions({
    collection: validationSamples,
    properties: [CLASS_PROPERTY],
    scale: CROP_SCALE_M,
    geometries: true,
    tileScale: 4
  }).classify(classifier);

  var confusionMatrix = validation.errorMatrix(CLASS_PROPERTY, 'classification');
  var accuracyTable = ee.FeatureCollection([
    ee.Feature(null, {
      year: CLASSIFICATION_YEAR,
      classifier: 'Random Forest',
      number_of_trees: RF_TREES,
      training_assets: TRAINING_RABI_ASSET + '; ' + TRAINING_KHARIF_ASSET,
      overall_accuracy: confusionMatrix.accuracy(),
      kappa: confusionMatrix.kappa(),
      producers_accuracy: confusionMatrix.producersAccuracy(),
      consumers_accuracy: confusionMatrix.consumersAccuracy(),
      confusion_matrix: confusionMatrix.array()
    })
  ]);

  var cropAreaTable = ee.FeatureCollection([]);
  CROPS.forEach(function(crop) {
    var cropArea = ee.Image.pixelArea().divide(10000)
      .updateMask(cropMap.eq(crop.code))
      .rename('mapped_area_ha');
    var cropRows = cropArea.reduceRegions({
      collection: studyDistricts,
      reducer: ee.Reducer.sum(),
      scale: TABLE_SCALE_M,
      crs: ANALYSIS_CRS,
      tileScale: 4
    }).filter(ee.Filter.gt('mapped_area_ha', 0)).map(function(feature) {
      return feature.set({
        year: CLASSIFICATION_YEAR,
        crop_code: crop.code,
        crop_name: crop.name,
        season: crop.season,
        area_unit: 'ha',
        source: 'Random Forest crop classification'
      });
    });
    cropAreaTable = cropAreaTable.merge(cropRows);
  });

  Map.addLayer(cropMap, {
    min: 1,
    max: 6,
    palette: ['d9b44a', '4daf4a', 'e41a1c', '984ea3', 'ff7f00', 'bdbdbd']
  }, 'RF crop classification - wheat/rice/cotton/sugarcane/maize', true);
  print('Validation confusion matrix', confusionMatrix);
  print('Accuracy table', accuracyTable);

  if (RUN_EXPORTS) {
    Export.image.toDrive({
      image: cropMap,
      description: 'map_crop_classification_RF_' + CLASSIFICATION_YEAR + '_unit_crop_code',
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'map_crop_classification_RF_' + CLASSIFICATION_YEAR + '_unit_crop_code',
      region: studyArea,
      scale: CROP_SCALE_M,
      crs: ANALYSIS_CRS,
      maxPixels: 1e13
    });

    Export.table.toDrive({
      collection: accuracyTable,
      description: 'table_crop_classification_accuracy_RF_' + CLASSIFICATION_YEAR,
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'table_crop_classification_accuracy_RF_' + CLASSIFICATION_YEAR,
      fileFormat: 'CSV'
    });

    Export.table.toDrive({
      collection: cropAreaTable,
      description: 'table_district_crop_area_RF_' + CLASSIFICATION_YEAR + '_unit_ha',
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'table_district_crop_area_RF_' + CLASSIFICATION_YEAR + '_unit_ha',
      fileFormat: 'CSV'
    });

    Export.image.toDrive({
      image: predictors,
      description: 'stack_crop_classification_predictors_' + CLASSIFICATION_YEAR + '_unit_indices',
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'stack_crop_classification_predictors_' + CLASSIFICATION_YEAR + '_unit_indices',
      region: studyArea,
      scale: CROP_SCALE_M,
      crs: ANALYSIS_CRS,
      maxPixels: 1e13
    });
  }
} else {
  print('Classification not run. Set USE_TRAINING_ASSET = true after uploading validated crop samples.');
  print('Training sample CSV schema/template', trainingTemplate());

  if (RUN_EXPORTS) {
    Export.table.toDrive({
      collection: trainingTemplate(),
      description: 'template_crop_training_validation_samples_' + CLASSIFICATION_YEAR,
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'template_crop_training_validation_samples_' + CLASSIFICATION_YEAR,
      fileFormat: 'CSV'
    });

    Export.image.toDrive({
      image: predictors,
      description: 'stack_crop_classification_predictors_' + CLASSIFICATION_YEAR + '_unit_indices',
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'stack_crop_classification_predictors_' + CLASSIFICATION_YEAR + '_unit_indices',
      region: studyArea,
      scale: CROP_SCALE_M,
      crs: ANALYSIS_CRS,
      maxPixels: 1e13
    });
  }
}
