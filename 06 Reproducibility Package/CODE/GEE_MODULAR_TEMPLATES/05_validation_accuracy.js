// 05_validation_and_accuracy.js
// Training/validation sample QA and Random Forest accuracy assessment.
//
// This file is intentionally standalone so validation can be rerun after
// changing samples, years, crop calendar windows, or classifier settings.

// ============================= USER SETTINGS ==============================
var RUN_EXPORTS = false;
var USE_VALIDATED_PREDICTOR_SAMPLE_ASSETS = true;
var RABI_PREDICTOR_SAMPLES_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/rf_predictor_samples_rabi_2023_30m';
var KHARIF_PREDICTOR_SAMPLES_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/rf_predictor_samples_kharif_2023_30m';
var TRAINING_RABI_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/adb_ground_truth_rabi_2023';
var TRAINING_KHARIF_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/adb_ground_truth_kharif_2023';
var USE_TRAINING_ASSET = false;
var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var CLASSIFICATION_YEAR = 2023;
var ANALYSIS_CRS = 'EPSG:32642';
var CROP_SCALE_M = 30;
var INDUS_MAIN_BAS = 4050033640;
var CLASS_PROPERTY = 'class_code';
var SPLIT_PROPERTY = 'split';
var RF_TREES = 300;
var RF_SEED = 20260709;

var FEATURE_WINDOWS = [
  {key: 'wheat_rabi', startMonth: 11, startDay: 1, startYearOffset: -1, endMonth: 4, endDay: 30, endYearOffset: 0},
  {key: 'rice_peak', startMonth: 7, startDay: 1, startYearOffset: 0, endMonth: 9, endDay: 30, endYearOffset: 0},
  {key: 'cotton_peak', startMonth: 6, startDay: 1, startYearOffset: 0, endMonth: 10, endDay: 31, endYearOffset: 0},
  {key: 'sugarcane_annual', startMonth: 1, startDay: 1, startYearOffset: 0, endMonth: 12, endDay: 31, endYearOffset: 0},
  {key: 'maize_main', startMonth: 2, startDay: 1, startYearOffset: 0, endMonth: 11, endDay: 30, endYearOffset: 0}
];

// ============================= STUDY AREA/MASK ============================
var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0').filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');
var studyArea = hydro5.filter(ee.Filter.eq('MAIN_BAS', INDUS_MAIN_BAS)).geometry()
  .intersection(pakistan.geometry(), ee.ErrorMargin(1000));
var croplandMask = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map')
  .eq(40).selfMask().rename('cropland').clip(studyArea);

// ============================= SENSOR HELPERS =============================
function maskS2sr(image) {
  var scl = image.select('SCL');
  var sclMask = scl.neq(3).and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
  var qa = image.select('QA60');
  var qaMask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0));
  return image.select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'])
    .divide(10000)
    .rename(['blue', 'green', 'red', 'nir', 'swir1', 'swir2'])
    .updateMask(sclMask)
    .updateMask(qaMask)
    .copyProperties(image, ['system:time_start']);
}

function maskLandsatC2L2(image) {
  var qa = image.select('QA_PIXEL');
  var clear = qa.bitwiseAnd(1 << 0).eq(0)
    .and(qa.bitwiseAnd(1 << 1).eq(0))
    .and(qa.bitwiseAnd(1 << 2).eq(0))
    .and(qa.bitwiseAnd(1 << 3).eq(0))
    .and(qa.bitwiseAnd(1 << 4).eq(0))
    .and(qa.bitwiseAnd(1 << 5).eq(0));
  var saturation = image.select('QA_RADSAT').eq(0);
  return image.select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'])
    .multiply(0.0000275).add(-0.2)
    .rename(['blue', 'green', 'red', 'nir', 'swir1', 'swir2'])
    .updateMask(clear)
    .updateMask(saturation)
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
  return {
    start: ee.Date.fromYMD(year + window.startYearOffset, window.startMonth, window.startDay),
    end: ee.Date.fromYMD(year + window.endYearOffset, window.endMonth, window.endDay).advance(1, 'day')
  };
}

function collectionForWindow(start, end, sensorName) {
  if (sensorName === 's2') {
    return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(studyArea)
      .filterDate(start, end)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 75))
      .map(maskS2sr)
      .map(addIndices);
  }
  var l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2').filterBounds(studyArea).filterDate(start, end);
  var l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2').filterBounds(studyArea).filterDate(start, end);
  return l8.merge(l9).map(maskLandsatC2L2).map(addIndices);
}

function compositeForWindow(year, window, sensorName) {
  var d = datesFromWindow(year, window);
  var ic = collectionForWindow(d.start, d.end, sensorName);
  var bands = ['NDVI', 'EVI', 'NDWI', 'LSWI', 'SAVI'];
  var median = ic.select(bands).median();
  var p = ic.select('NDVI').reduce(ee.Reducer.percentile([10, 90]));
  var image = median.addBands(p);
  var oldNames = ['NDVI', 'EVI', 'NDWI', 'LSWI', 'SAVI', 'NDVI_p10', 'NDVI_p90'];
  return image.rename(oldNames.map(function(name) {
    return sensorName + '_' + window.key + '_' + name;
  })).toFloat();
}

function buildPredictorStack(year) {
  var stack = ee.Image(0).rename('constant').updateMask(croplandMask);
  FEATURE_WINDOWS.forEach(function(window) {
    stack = stack.addBands(compositeForWindow(year, window, 's2'));
    stack = stack.addBands(compositeForWindow(year, window, 'landsat'));
  });
  return stack.select(stack.bandNames().remove('constant')).updateMask(croplandMask).clip(studyArea);
}

function sampleCountTable(samples) {
  var histogram = ee.Dictionary(samples.aggregate_histogram(CLASS_PROPERTY));
  return ee.FeatureCollection(histogram.keys().map(function(classCode) {
    return ee.Feature(null, {
      crop_code: classCode,
      sample_count: histogram.get(classCode),
      year: CLASSIFICATION_YEAR,
      source_asset: 'user-configured training asset'
    });
  }));
}

// ============================== VALIDATION ================================
Map.centerObject(studyArea, 6);
var predictors = buildPredictorStack(CLASSIFICATION_YEAR);
Map.addLayer(predictors.select('s2_rice_peak_NDVI'), {min: 0, max: 0.8, palette: ['f7f7d2', '74c476', '00441b']}, 'Validation predictor preview - S2 rice NDVI', false);

if (USE_VALIDATED_PREDICTOR_SAMPLE_ASSETS) {
  function validateSampledPredictors(assetId, seasonName, classOrder) {
    var sampled = ee.FeatureCollection(assetId);
    var metadataProperties = ['system:index', 'sample_id', 'season', 'class_code', 'crop_name', 'split', 'block_id'];
    var predictorBands = ee.Feature(sampled.first()).propertyNames().removeAll(metadataProperties);
    var trainingRows = sampled.filter(ee.Filter.eq(SPLIT_PROPERTY, 'training'));
    var validationRows = sampled.filter(ee.Filter.eq(SPLIT_PROPERTY, 'validation'));
    var classifier = ee.Classifier.smileRandomForest({
      numberOfTrees: RF_TREES,
      minLeafPopulation: 2,
      bagFraction: 0.7,
      seed: RF_SEED
    }).train({
      features: trainingRows,
      classProperty: CLASS_PROPERTY,
      inputProperties: predictorBands
    });
    var validated = validationRows.classify(classifier, 'predicted');
    var matrix = validated.errorMatrix(CLASS_PROPERTY, 'predicted', classOrder);
    var summary = ee.Feature(null, {
      season: seasonName,
      year: CLASSIFICATION_YEAR,
      sampled_predictor_asset: assetId,
      field_source: 'ADB/MNFSR/CRS ground truth, DOI 10.5281/zenodo.11047562, CC BY 4.0',
      validation_design: 'independent 0.05-degree spatial blocks',
      classifier: 'smileRandomForest',
      number_of_trees: RF_TREES,
      predictor_count: predictorBands.size(),
      training_sample_count: trainingRows.size(),
      validation_sample_count: validationRows.size(),
      class_order: classOrder,
      overall_accuracy: matrix.accuracy(),
      kappa: matrix.kappa(),
      producers_accuracy: matrix.producersAccuracy(),
      consumers_accuracy: matrix.consumersAccuracy(),
      confusion_matrix: matrix.array()
    });
    print(seasonName + ' confusion matrix', matrix);
    print(seasonName + ' accuracy summary', summary);
    return summary;
  }

  var validatedAccuracy = ee.FeatureCollection([
    validateSampledPredictors(RABI_PREDICTOR_SAMPLES_ASSET, 'Rabi', [1, 4, 5, 6]),
    validateSampledPredictors(KHARIF_PREDICTOR_SAMPLES_ASSET, 'Kharif', [2, 3, 4, 5, 6])
  ]);
  print('Validated seasonal accuracy', validatedAccuracy);
  if (RUN_EXPORTS) {
    Export.table.toDrive({
      collection: validatedAccuracy,
      description: 'table_validation_accuracy_RF_spatial_blocks_2023',
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'table_validation_accuracy_RF_spatial_blocks_2023',
      fileFormat: 'CSV'
    });
  }
} else if (USE_TRAINING_ASSET) {
  var samples = ee.FeatureCollection(TRAINING_RABI_ASSET)
    .merge(ee.FeatureCollection(TRAINING_KHARIF_ASSET))
    .filterBounds(studyArea)
    .filter(ee.Filter.notNull([CLASS_PROPERTY]));

  // Respect user train/validation split where present. If split is missing for
  // some samples, assign a reproducible random split.
  var withRandom = samples.randomColumn('random_split', RF_SEED);
  var samplesPrepared = withRandom.map(function(f) {
    var existing = f.get(SPLIT_PROPERTY);
    var generated = ee.Algorithms.If(ee.Number(f.get('random_split')).lt(0.7), 'training', 'validation');
    return f.set(SPLIT_PROPERTY, ee.Algorithms.If(existing, existing, generated));
  });

  var trainFc = samplesPrepared.filter(ee.Filter.eq(SPLIT_PROPERTY, 'training'));
  var validationFc = samplesPrepared.filter(ee.Filter.eq(SPLIT_PROPERTY, 'validation'));
  print('Training sample counts by crop_code', sampleCountTable(trainFc));
  print('Validation sample counts by crop_code', sampleCountTable(validationFc));

  var training = predictors.sampleRegions({
    collection: trainFc,
    properties: [CLASS_PROPERTY],
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

  var classified = predictors.classify(classifier).rename('crop_code').updateMask(croplandMask).clip(studyArea);
  var validation = predictors.sampleRegions({
    collection: validationFc,
    properties: [CLASS_PROPERTY],
    scale: CROP_SCALE_M,
    geometries: true,
    tileScale: 4
  }).classify(classifier);

  var matrix = validation.errorMatrix(CLASS_PROPERTY, 'classification');
  var accuracySummary = ee.FeatureCollection([
    ee.Feature(null, {
      year: CLASSIFICATION_YEAR,
      training_assets: TRAINING_RABI_ASSET + '; ' + TRAINING_KHARIF_ASSET,
      classifier: 'smileRandomForest',
      number_of_trees: RF_TREES,
      overall_accuracy: matrix.accuracy(),
      kappa: matrix.kappa(),
      producers_accuracy: matrix.producersAccuracy(),
      consumers_accuracy: matrix.consumersAccuracy(),
      confusion_matrix: matrix.array(),
      unit: 'unitless accuracy metrics'
    })
  ]);

  Map.addLayer(classified, {
    min: 1,
    max: 6,
    palette: ['d9b44a', '4daf4a', 'e41a1c', '984ea3', 'ff7f00', 'bdbdbd']
  }, 'Validated RF crop map preview', true);
  print('Confusion matrix', matrix);
  print('Accuracy summary', accuracySummary);

  if (RUN_EXPORTS) {
    Export.table.toDrive({
      collection: accuracySummary,
      description: 'table_validation_accuracy_RF_' + CLASSIFICATION_YEAR,
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'table_validation_accuracy_RF_' + CLASSIFICATION_YEAR,
      fileFormat: 'CSV'
    });

    Export.table.toDrive({
      collection: sampleCountTable(trainFc),
      description: 'table_training_sample_counts_' + CLASSIFICATION_YEAR,
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'table_training_sample_counts_' + CLASSIFICATION_YEAR,
      fileFormat: 'CSV'
    });

    Export.table.toDrive({
      collection: sampleCountTable(validationFc),
      description: 'table_validation_sample_counts_' + CLASSIFICATION_YEAR,
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'table_validation_sample_counts_' + CLASSIFICATION_YEAR,
      fileFormat: 'CSV'
    });
  }
} else {
  var status = ee.FeatureCollection([
    ee.Feature(null, {
      status: 'not_run',
      reason: 'USE_TRAINING_ASSET is false. Upload validated samples and set it to true.',
      required_asset_schema: 'sample_id,class_code,crop_name,split,block_id',
      year: CLASSIFICATION_YEAR
    })
  ]);
  print('Validation status', status);
  if (RUN_EXPORTS) {
    Export.table.toDrive({
      collection: status,
      description: 'table_validation_status_training_samples_required_' + CLASSIFICATION_YEAR,
      folder: EXPORT_FOLDER,
      fileNamePrefix: 'table_validation_status_training_samples_required_' + CLASSIFICATION_YEAR,
      fileFormat: 'CSV'
    });
  }
}
