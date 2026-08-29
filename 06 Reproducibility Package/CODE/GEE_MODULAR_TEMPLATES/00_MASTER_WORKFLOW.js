// Google Earth Engine master workflow
// Research: Indus Basin irrigated agriculture green/blue water use and virtual water footprint
// Use in the GEE Code Editor opened with Microsoft Edge.

var RUN_EXPORTS = false;  // Set true only after inspecting layers.
var USE_CROP_TRAINING_ASSET = false;  // Set true when validated samples are available.
var CROP_TRAINING_ASSET = 'users/YOUR_USERNAME/indus_crop_training_samples';
var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var ANALYSIS_CRS = 'EPSG:32642';
var WATER_SCALE = 250;
var CROP_SCALE = 30;
var YEARS = [2021, 2022, 2023];
var PRELIMINARY_MAP_YEAR = 2023;
var PRELIMINARY_MAP_SEASON = 'kharif';

var CROP_CODES = [
  {crop_code: 1, crop_name: 'Wheat', season: 'rabi'},
  {crop_code: 2, crop_name: 'Rice', season: 'kharif'},
  {crop_code: 3, crop_name: 'Cotton', season: 'kharif'},
  {crop_code: 4, crop_name: 'Sugarcane', season: 'annual'},
  {crop_code: 5, crop_name: 'Maize', season: 'kharif_rabi'}
];

// ---------------------------------------------------------------------------
// 1. Study-area preparation
// ---------------------------------------------------------------------------
var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0')
  .filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var provinces = ee.FeatureCollection('FAO/GAUL/2015/level1')
  .filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var districts = ee.FeatureCollection('FAO/GAUL/2015/level2')
  .filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));

var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');
var indusOutlet = ee.Geometry.Point([68.0, 24.5]);
var outletBasin = ee.Feature(hydro5.filterBounds(indusOutlet).sort('UP_AREA', false).first());
var indusMainBas = ee.Number(outletBasin.get('MAIN_BAS'));
var indusBasin = hydro5.filter(ee.Filter.eq('MAIN_BAS', indusMainBas));
var studyArea = indusBasin.geometry().intersection(pakistan.geometry(), ee.ErrorMargin(1000));
var studyDistricts = districts.filterBounds(studyArea);
var studyProvinces = provinces.filterBounds(studyArea);

print('Indus MAIN_BAS inferred from outlet', indusMainBas);
print('Pakistan Indus area km2', studyArea.area(1000).divide(1e6));
print('Study districts', studyDistricts.size());

Map.centerObject(studyArea, 6);
Map.addLayer(studyArea, {color: '111111'}, 'Study area: Indus Basin in Pakistan', false);

// ---------------------------------------------------------------------------
// 2. Cropland mask
// ---------------------------------------------------------------------------
var worldCover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
var croplandMask = worldCover.eq(40).selfMask().clip(studyArea).rename('cropland');
Map.addLayer(croplandMask, {palette: ['#74a57f']}, 'ESA WorldCover cropland mask', false);

// ---------------------------------------------------------------------------
// 3. Sentinel-2 indices and seasonal composites
// ---------------------------------------------------------------------------
function maskS2sr(image) {
  var scl = image.select('SCL');
  var valid = scl.neq(3)
    .and(scl.neq(8))
    .and(scl.neq(9))
    .and(scl.neq(10))
    .and(scl.neq(11));
  var optical = image.select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12']).divide(10000);
  return optical.updateMask(valid).copyProperties(image, ['system:time_start']);
}

function addS2Indices(image) {
  var ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI');
  var ndwi = image.normalizedDifference(['B3', 'B8']).rename('NDWI');
  var lswi = image.normalizedDifference(['B8', 'B11']).rename('LSWI');
  var evi = image.expression(
    '2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))',
    {
      NIR: image.select('B8'),
      RED: image.select('B4'),
      BLUE: image.select('B2')
    }
  ).rename('EVI');
  return image.addBands([ndvi, evi, ndwi, lswi]);
}

function seasonDates(year, season) {
  year = ee.Number(year);
  var start;
  var end;
  if (season === 'kharif') {
    start = ee.Date.fromYMD(year, 5, 1);
    end = ee.Date.fromYMD(year, 12, 1);
  } else if (season === 'rabi') {
    start = ee.Date.fromYMD(year.subtract(1), 11, 1);
    end = ee.Date.fromYMD(year, 5, 1);
  } else {
    start = ee.Date.fromYMD(year, 1, 1);
    end = ee.Date.fromYMD(year.add(1), 1, 1);
  }
  return ee.Dictionary({start: start, end: end});
}

function s2SeasonComposite(year, season) {
  var d = seasonDates(year, season);
  var start = ee.Date(d.get('start'));
  var end = ee.Date(d.get('end'));
  var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(studyArea)
    .filterDate(start, end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 70))
    .map(maskS2sr)
    .map(addS2Indices);
  var composite = s2.select(['NDVI', 'EVI', 'NDWI', 'LSWI']).median()
    .updateMask(croplandMask)
    .clip(studyArea);
  return composite.rename([
    season + '_NDVI',
    season + '_EVI',
    season + '_NDWI',
    season + '_LSWI'
  ]).set({
    year: year,
    season: season,
    start: start.format('YYYY-MM-dd'),
    end: end.advance(-1, 'day').format('YYYY-MM-dd')
  });
}

var kharifComposite = s2SeasonComposite(PRELIMINARY_MAP_YEAR, 'kharif');
var rabiComposite = s2SeasonComposite(PRELIMINARY_MAP_YEAR, 'rabi');
var phenologyStack = kharifComposite.addBands(rabiComposite).clip(studyArea);

Map.addLayer(kharifComposite.select('kharif_NDVI'), {min: 0, max: 0.8, palette: ['#f2f0d7', '#8cc084', '#20603d']}, 'Kharif NDVI', false);
Map.addLayer(rabiComposite.select('rabi_NDVI'), {min: 0, max: 0.8, palette: ['#f2f0d7', '#8cc084', '#20603d']}, 'Rabi NDVI', false);

// ---------------------------------------------------------------------------
// 4. Major crop mapping
// ---------------------------------------------------------------------------
var cropMap;
var classifierInfo;
if (USE_CROP_TRAINING_ASSET) {
  var samples = ee.FeatureCollection(CROP_TRAINING_ASSET).filterBounds(studyArea);
  var trainingSamples = samples.filter(ee.Filter.eq('split', 'train'));
  var validationSamples = samples.filter(ee.Filter.eq('split', 'validation'));

  var training = phenologyStack.sampleRegions({
    collection: trainingSamples,
    properties: ['crop_code', 'crop_name', 'season', 'year'],
    scale: CROP_SCALE,
    geometries: true,
    tileScale: 4
  });

  var classifier = ee.Classifier.smileRandomForest({
    numberOfTrees: 300,
    variablesPerSplit: null,
    minLeafPopulation: 2,
    bagFraction: 0.7,
    seed: 20260709
  }).train({
    features: training,
    classProperty: 'crop_code',
    inputProperties: phenologyStack.bandNames()
  });

  cropMap = phenologyStack.classify(classifier)
    .rename('crop_code')
    .updateMask(croplandMask)
    .clip(studyArea);

  var validation = phenologyStack.sampleRegions({
    collection: validationSamples,
    properties: ['crop_code'],
    scale: CROP_SCALE,
    geometries: true,
    tileScale: 4
  }).classify(classifier);

  var confusionMatrix = validation.errorMatrix('crop_code', 'classification');
  classifierInfo = ee.FeatureCollection([
    ee.Feature(null, {
      overall_accuracy: confusionMatrix.accuracy(),
      kappa: confusionMatrix.kappa(),
      producers_accuracy: confusionMatrix.producersAccuracy(),
      consumers_accuracy: confusionMatrix.consumersAccuracy(),
      confusion_matrix: confusionMatrix.array()
    })
  ]);
  print('Crop classification confusion matrix', confusionMatrix);
  print('Crop classification overall accuracy', confusionMatrix.accuracy());
} else {
  // This is not a crop classification. It is provided only to inspect separability
  // before defensible training samples are supplied.
  var clusterer = ee.Clusterer.wekaKMeans(8).train({
    features: phenologyStack.sample({
      region: studyArea,
      scale: WATER_SCALE,
      numPixels: 8000,
      seed: 20260709,
      tileScale: 4
    }),
    inputProperties: phenologyStack.bandNames()
  });
  cropMap = phenologyStack.cluster(clusterer).rename('phenology_cluster')
    .updateMask(croplandMask)
    .clip(studyArea);
  classifierInfo = ee.FeatureCollection([
    ee.Feature(null, {
      status: 'Crop classification not run. Supply validated crop training and validation samples.',
      output: 'phenology_cluster is unvalidated and must not be interpreted as crop labels.'
    })
  ]);
}

Map.addLayer(cropMap, {
  min: 0,
  max: 8,
  palette: ['#999999', '#d9b44a', '#5aae61', '#3288bd', '#d53e4f', '#abdda4', '#fdae61', '#542788', '#66c2a5']
}, USE_CROP_TRAINING_ASSET ? 'Major crop classification' : 'Unvalidated phenology clusters', false);

// ---------------------------------------------------------------------------
// 5. Actual ET, rainfall, and effective rainfall
// ---------------------------------------------------------------------------
function waporAetiSeason(year, season) {
  var d = seasonDates(year, season);
  var start = ee.Date(d.get('start'));
  var end = ee.Date(d.get('end'));
  var aeti = ee.ImageCollection('FAO/WAPOR/3/L1_AETI_D')
    .filterBounds(studyArea)
    .filterDate(start, end)
    .map(function(image) {
      var date = ee.Date(image.get('system:time_start'));
      var day = ee.Number.parse(date.format('d'));
      var monthStart = ee.Date.fromYMD(
        ee.Number.parse(date.format('Y')),
        ee.Number.parse(date.format('M')),
        1
      );
      var nextMonthStart = monthStart.advance(1, 'month');
      var dekadEnd = ee.Date(ee.Algorithms.If(day.lt(21), date.advance(10, 'day'), nextMonthStart));
      var clippedEnd = ee.Date(ee.Algorithms.If(dekadEnd.millis().gt(end.millis()), end, dekadEnd));
      var days = clippedEnd.difference(date, 'day').max(0);
      return image.select('L1-AETI-D')
        .multiply(0.1)
        .multiply(days)
        .rename('aeti_mm')
        .toFloat()
        .copyProperties(image, ['system:time_start']);
    })
    .sum()
    .updateMask(croplandMask)
    .clip(studyArea)
    .set({year: year, season: season});
  return aeti;
}

function chirpsRainSeason(year, season) {
  var d = seasonDates(year, season);
  var start = ee.Date(d.get('start'));
  var end = ee.Date(d.get('end'));
  return ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
    .filterBounds(studyArea)
    .filterDate(start, end)
    .select('precipitation')
    .sum()
    .rename('rainfall_mm')
    .clip(studyArea)
    .set({year: year, season: season});
}

function effectiveRainSeason(year, season) {
  var d = seasonDates(year, season);
  var start = ee.Date(d.get('start'));
  var end = ee.Date(d.get('end'));
  var nMonths = end.difference(start, 'month').round();
  var monthOffsets = ee.List.sequence(0, nMonths.subtract(1));
  var monthlyPeff = ee.ImageCollection.fromImages(monthOffsets.map(function(offset) {
    offset = ee.Number(offset);
    var mStart = start.advance(offset, 'month');
    var rawEnd = mStart.advance(1, 'month');
    var mEnd = ee.Date(ee.Algorithms.If(rawEnd.millis().gt(end.millis()), end, rawEnd));
    var p = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
      .filterBounds(studyArea)
      .filterDate(mStart, mEnd)
      .select('precipitation')
      .sum()
      .rename('monthly_p_mm');
    var peffLow = p.multiply(ee.Image.constant(125).subtract(p.multiply(0.2))).divide(125);
    var peffHigh = p.multiply(0.1).add(125);
    return peffLow.where(p.gt(250), peffHigh).max(0).rename('effective_rainfall_mm').toFloat();
  }));
  return monthlyPeff.sum()
    .updateMask(croplandMask)
    .clip(studyArea)
    .set({year: year, season: season});
}

// ---------------------------------------------------------------------------
// 6. Green and blue water use
// ---------------------------------------------------------------------------
function waterUseImages(year, season) {
  var aeti = waporAetiSeason(year, season);
  var rain = chirpsRainSeason(year, season);
  var effectiveRain = effectiveRainSeason(year, season);
  var green = aeti.min(effectiveRain).rename('green_water_mm');
  var blue = aeti.subtract(green).max(0).rename('blue_water_mm');
  var total = aeti.rename('total_crop_water_use_mm');
  return ee.Image.cat([
    total,
    green,
    blue,
    rain.rename('rainfall_mm'),
    effectiveRain.rename('effective_rainfall_mm')
  ]).updateMask(croplandMask).clip(studyArea).set({year: year, season: season});
}

var preliminaryWater = waterUseImages(PRELIMINARY_MAP_YEAR, PRELIMINARY_MAP_SEASON);
Map.addLayer(preliminaryWater.select('total_crop_water_use_mm'), {min: 0, max: 900, palette: ['#f7fcf5', '#74c476', '#00441b']}, 'Total crop water use mm', true);
Map.addLayer(preliminaryWater.select('green_water_mm'), {min: 0, max: 500, palette: ['#ffffcc', '#78c679', '#006837']}, 'Green water use mm', false);
Map.addLayer(preliminaryWater.select('blue_water_mm'), {min: 0, max: 500, palette: ['#f7fbff', '#6baed6', '#08306b']}, 'Blue water use mm', false);

// ---------------------------------------------------------------------------
// 7. District/crop water-use tables and virtual water footprint export base
// ---------------------------------------------------------------------------
function districtCroplandWaterTable(year, season) {
  var water = waterUseImages(year, season);
  var pixelArea = ee.Image.pixelArea();
  var volumeImage = ee.Image.cat([
    pixelArea.divide(10000).rename('cropland_area_ha'),
    water.select('green_water_mm').multiply(pixelArea).multiply(0.001).rename('green_water_m3'),
    water.select('blue_water_mm').multiply(pixelArea).multiply(0.001).rename('blue_water_m3'),
    water.select('total_crop_water_use_mm').multiply(pixelArea).multiply(0.001).rename('total_crop_water_m3')
  ]).updateMask(croplandMask);

  return volumeImage.reduceRegions({
    collection: studyDistricts,
    reducer: ee.Reducer.sum(),
    scale: WATER_SCALE,
    crs: ANALYSIS_CRS,
    tileScale: 4
  }).map(function(feature) {
    return feature.set({
      year: year,
      season: season,
      crop_code: 0,
      crop_name: USE_CROP_TRAINING_ASSET ? 'All mapped cropland' : 'All cropland - crop labels unavailable'
    });
  });
}

function districtCropWaterTable(year, season) {
  var water = waterUseImages(year, season);
  var pixelArea = ee.Image.pixelArea();
  var codes = USE_CROP_TRAINING_ASSET ? ee.List(CROP_CODES.map(function(c) { return c.crop_code; })) : ee.List([0]);

  var tables = codes.map(function(code) {
    code = ee.Number(code);
    var mask = USE_CROP_TRAINING_ASSET ? cropMap.eq(code) : croplandMask;
    var volumeImage = ee.Image.cat([
      pixelArea.divide(10000).rename('mapped_area_ha'),
      water.select('green_water_mm').multiply(pixelArea).multiply(0.001).rename('green_water_m3'),
      water.select('blue_water_mm').multiply(pixelArea).multiply(0.001).rename('blue_water_m3'),
      water.select('total_crop_water_use_mm').multiply(pixelArea).multiply(0.001).rename('total_crop_water_m3')
    ]).updateMask(mask);

    return volumeImage.reduceRegions({
      collection: studyDistricts,
      reducer: ee.Reducer.sum(),
      scale: WATER_SCALE,
      crs: ANALYSIS_CRS,
      tileScale: 4
    }).map(function(feature) {
      return feature.set({
        year: year,
        season: season,
        crop_code: code,
        crop_name: ee.Algorithms.If(code.eq(0), 'All cropland - crop labels unavailable', 'See crop code lookup')
      });
    });
  });

  return ee.FeatureCollection(tables).flatten();
}

var tableOneSeason = districtCropWaterTable(PRELIMINARY_MAP_YEAR, PRELIMINARY_MAP_SEASON);
print('District crop/cropland water-use table preview', tableOneSeason.limit(5));

// VWF is completed after export by scripts/python/postprocess_gee_results.py
// using official crop yield/production statistics. Do not compute final VWF in
// GEE unless production/yield attributes have been joined from official data.

// ---------------------------------------------------------------------------
// 8. Exports
// ---------------------------------------------------------------------------
function exportImage(image, description, scale) {
  Export.image.toDrive({
    image: image,
    description: description,
    folder: EXPORT_FOLDER,
    fileNamePrefix: description,
    region: studyArea,
    scale: scale,
    crs: ANALYSIS_CRS,
    maxPixels: 1e13
  });
}

function exportTable(collection, description) {
  Export.table.toDrive({
    collection: collection,
    description: description,
    folder: EXPORT_FOLDER,
    fileNamePrefix: description,
    fileFormat: 'CSV'
  });
}

if (RUN_EXPORTS) {
  exportImage(croplandMask, 'cropland_mask_worldcover_indus_pakistan', CROP_SCALE);
  exportImage(kharifComposite, 'seasonal_indices_kharif_' + PRELIMINARY_MAP_YEAR, CROP_SCALE);
  exportImage(rabiComposite, 'seasonal_indices_rabi_' + PRELIMINARY_MAP_YEAR, CROP_SCALE);
  exportImage(cropMap, USE_CROP_TRAINING_ASSET ? 'crop_classification_' + PRELIMINARY_MAP_YEAR : 'phenology_clusters_unvalidated_' + PRELIMINARY_MAP_YEAR, CROP_SCALE);
  exportImage(preliminaryWater.select('total_crop_water_use_mm'), 'total_crop_water_use_' + PRELIMINARY_MAP_SEASON + '_' + PRELIMINARY_MAP_YEAR, WATER_SCALE);
  exportImage(preliminaryWater.select('green_water_mm'), 'green_water_use_' + PRELIMINARY_MAP_SEASON + '_' + PRELIMINARY_MAP_YEAR, WATER_SCALE);
  exportImage(preliminaryWater.select('blue_water_mm'), 'blue_water_use_' + PRELIMINARY_MAP_SEASON + '_' + PRELIMINARY_MAP_YEAR, WATER_SCALE);
  exportImage(preliminaryWater.select('rainfall_mm'), 'rainfall_' + PRELIMINARY_MAP_SEASON + '_' + PRELIMINARY_MAP_YEAR, WATER_SCALE);
  exportImage(preliminaryWater.select('effective_rainfall_mm'), 'effective_rainfall_' + PRELIMINARY_MAP_SEASON + '_' + PRELIMINARY_MAP_YEAR, WATER_SCALE);
  exportTable(districtCroplandWaterTable(PRELIMINARY_MAP_YEAR, PRELIMINARY_MAP_SEASON), 'district_cropland_water_use_' + PRELIMINARY_MAP_SEASON + '_' + PRELIMINARY_MAP_YEAR);
  exportTable(tableOneSeason, 'district_crop_water_use_' + PRELIMINARY_MAP_SEASON + '_' + PRELIMINARY_MAP_YEAR);
  exportTable(classifierInfo, 'classification_accuracy_or_status_' + PRELIMINARY_MAP_YEAR);
  exportTable(studyDistricts, 'study_districts_indus_pakistan');
}
