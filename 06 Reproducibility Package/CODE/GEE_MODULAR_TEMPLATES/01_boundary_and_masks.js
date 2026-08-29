// 01_boundary_and_masks.js
// Indus Basin Irrigated Agriculture System of Pakistan:
// study boundary, administrative units, ESA WorldCover cropland mask, and
// dynamic vegetation cropland-support mask.
//
// Open in Google Earth Engine Code Editor. Use Microsoft Edge for browser
// login/authentication if Earth Engine asks you to sign in.

// ============================= USER SETTINGS ==============================
var RUN_EXPORTS = false;
var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var ANALYSIS_YEAR = 2023;
var ANALYSIS_CRS = 'EPSG:32642';  // UTM Zone 42N; accepted by GEE in this environment.
var CROP_SCALE_M = 30;
var TABLE_SCALE_M = 250;
var GAUL2024_DISTRICTS_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/fao_gaul_2024_pak_adm2_karachi_aggregate';
var KARACHI_COMPONENT_CODES = ['130204', '130206', '130214', '130216', '130223', '130231'];

// Optional custom boundary. Keep false to build the boundary from HydroBASINS.
var USE_CUSTOM_STUDY_AREA_ASSET = false;
var CUSTOM_STUDY_AREA_ASSET = 'users/YOUR_USERNAME/indus_irrigated_agriculture_boundary';

// HydroBASINS Indus main basin identifier inferred from outlet near lower Indus.
var INDUS_MAIN_BAS = 4050033640;

// Dynamic vegetation threshold settings for cropland support mask.
var DYNAMIC_START = ANALYSIS_YEAR + '-01-01';
var DYNAMIC_END = (ANALYSIS_YEAR + 1) + '-01-01';
var NDVI_MAX_THRESHOLD = 0.35;
var DYNAMIC_WORLD_CROP_PROBABILITY = 0.40;
var NDVI_AMPLITUDE_THRESHOLD = 0.12;
var SLOPE_MAX_DEGREES = 12;
var ELEVATION_MAX_M = 2500;

// Combined cropland strategy:
// 'worldcover_only', 'dynamic_only', 'worldcover_or_dynamic', 'worldcover_and_dynamic'
var CROPLAND_STRATEGY = 'worldcover_or_dynamic';

// ============================ STUDY BOUNDARY ==============================
var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0')
  .filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var provinces = ee.FeatureCollection('FAO/GAUL/2015/level1')
  .filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var districts = ee.FeatureCollection(GAUL2024_DISTRICTS_ASSET)
  .filter(ee.Filter.inList('gaul2_code', KARACHI_COMPONENT_CODES).not());

var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');
var hydroIndus = hydro5.filter(ee.Filter.eq('MAIN_BAS', INDUS_MAIN_BAS));
var hydroStudyArea = hydroIndus.geometry().intersection(pakistan.geometry(), ee.ErrorMargin(1000));
var studyArea = USE_CUSTOM_STUDY_AREA_ASSET
  ? ee.FeatureCollection(CUSTOM_STUDY_AREA_ASSET).geometry()
  : hydroStudyArea;
var studyDistricts = districts.filterBounds(studyArea);
var studyProvinces = provinces.filterBounds(studyArea);

print('Study area source', ee.Algorithms.If(USE_CUSTOM_STUDY_AREA_ASSET, CUSTOM_STUDY_AREA_ASSET, 'HydroBASINS MAIN_BAS ' + INDUS_MAIN_BAS));
print('Study area km2', studyArea.area(1000).divide(1e6));
print('District count', studyDistricts.size());

// =========================== CLOUD MASKS/INDICES ==========================
function maskS2sr(image) {
  // Sentinel-2 SR cloud mask from SCL and QA60.
  var scl = image.select('SCL');
  var sclMask = scl.neq(3)   // cloud shadow
    .and(scl.neq(8))         // medium probability cloud
    .and(scl.neq(9))         // high probability cloud
    .and(scl.neq(10))        // cirrus
    .and(scl.neq(11));       // snow/ice
  var qa = image.select('QA60');
  var qaMask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0));
  var optical = image.select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'])
    .divide(10000)
    .rename(['blue', 'green', 'red', 'nir', 'swir1', 'swir2']);
  return optical.updateMask(sclMask).updateMask(qaMask)
    .copyProperties(image, ['system:time_start']);
}

function addIndices(image) {
  var ndvi = image.normalizedDifference(['nir', 'red']).rename('NDVI');
  var ndwi = image.normalizedDifference(['green', 'nir']).rename('NDWI');
  var lswi = image.normalizedDifference(['nir', 'swir1']).rename('LSWI');
  var evi = image.expression(
    '2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))',
    {NIR: image.select('nir'), RED: image.select('red'), BLUE: image.select('blue')}
  ).rename('EVI');
  var savi = image.expression(
    '1.5 * ((NIR - RED) / (NIR + RED + 0.5))',
    {NIR: image.select('nir'), RED: image.select('red')}
  ).rename('SAVI');
  return image.addBands([ndvi, evi, ndwi, lswi, savi]);
}

// ============================ CROPLAND MASKS ==============================
var worldCover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
var worldCoverCropland = worldCover.eq(40).selfMask()
  .rename('cropland_worldcover_esa_class40')
  .clip(studyArea)
  .set({
    source: 'ESA/WorldCover/v200',
    class_code: 40,
    class_name: 'Cropland',
    unit: 'binary mask',
    year: ANALYSIS_YEAR
  });

var s2Dynamic = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(studyArea)
  .filterDate(DYNAMIC_START, DYNAMIC_END)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 70))
  .map(maskS2sr)
  .map(addIndices);

var ndviMax = s2Dynamic.select('NDVI').max();
var ndviMin = s2Dynamic.select('NDVI').min();
var ndviAmplitude = ndviMax.subtract(ndviMin);
var dynamicWorldCropProbability = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
  .filterBounds(studyArea)
  .filterDate(DYNAMIC_START, DYNAMIC_END)
  .select('crops')
  .mean();
var elevation = ee.Image('USGS/SRTMGL1_003').select('elevation');
var slope = ee.Terrain.slope(elevation);

var dynamicCropland = dynamicWorldCropProbability.gte(DYNAMIC_WORLD_CROP_PROBABILITY)
  .and(ndviMax.gte(NDVI_MAX_THRESHOLD))
  .and(ndviAmplitude.gte(NDVI_AMPLITUDE_THRESHOLD))
  .and(slope.lte(SLOPE_MAX_DEGREES))
  .and(elevation.lt(ELEVATION_MAX_M))
  .selfMask()
  .rename('cropland_dynamic_vegetation')
  .clip(studyArea)
  .set({
    source: 'Dynamic World + Sentinel-2 SR Harmonized + SRTM',
    method: 'Dynamic World crop probability, NDVI maximum/amplitude, slope and elevation thresholds',
    dynamic_world_crop_probability: DYNAMIC_WORLD_CROP_PROBABILITY,
    ndvi_max_threshold: NDVI_MAX_THRESHOLD,
    ndvi_amplitude_threshold: NDVI_AMPLITUDE_THRESHOLD,
    slope_max_degrees: SLOPE_MAX_DEGREES,
    elevation_max_m: ELEVATION_MAX_M,
    unit: 'binary mask',
    year: ANALYSIS_YEAR
  });

var combinedCropland = ee.Image(ee.Algorithms.If(
  CROPLAND_STRATEGY === 'worldcover_only',
  worldCoverCropland,
  ee.Algorithms.If(
    CROPLAND_STRATEGY === 'dynamic_only',
    dynamicCropland,
    ee.Algorithms.If(
      CROPLAND_STRATEGY === 'worldcover_and_dynamic',
      worldCoverCropland.and(dynamicCropland).selfMask(),
      worldCoverCropland.unmask(0).or(dynamicCropland.unmask(0)).selfMask()
    )
  )
)).rename('cropland_mask').clip(studyArea).set({
  method: CROPLAND_STRATEGY,
  unit: 'binary mask',
  year: ANALYSIS_YEAR,
  notes: 'Use this mask for crop classification and water-use calculations after visual inspection.'
});

var areaImage = ee.Image.pixelArea().divide(10000).rename('area_ha');
var maskAreaStats = ee.FeatureCollection([
  ee.Feature(null, {
    layer_name: 'worldcover_cropland',
    year: ANALYSIS_YEAR,
    unit: 'ha',
    area_ha: areaImage.updateMask(worldCoverCropland).reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: studyArea,
      scale: TABLE_SCALE_M,
      crs: ANALYSIS_CRS,
      maxPixels: 1e13
    }).get('area_ha')
  }),
  ee.Feature(null, {
    layer_name: 'dynamic_vegetation_cropland_support',
    year: ANALYSIS_YEAR,
    unit: 'ha',
    area_ha: areaImage.updateMask(dynamicCropland).reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: studyArea,
      scale: TABLE_SCALE_M,
      crs: ANALYSIS_CRS,
      maxPixels: 1e13
    }).get('area_ha')
  }),
  ee.Feature(null, {
    layer_name: 'combined_cropland_mask',
    year: ANALYSIS_YEAR,
    unit: 'ha',
    strategy: CROPLAND_STRATEGY,
    area_ha: areaImage.updateMask(combinedCropland).reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: studyArea,
      scale: TABLE_SCALE_M,
      crs: ANALYSIS_CRS,
      maxPixels: 1e13
    }).get('area_ha')
  })
]);

// ================================ DISPLAY =================================
Map.centerObject(studyArea, 6);
Map.addLayer(studyArea, {color: '000000'}, 'Study area - Indus Basin within Pakistan', true);
Map.addLayer(studyDistricts.style({color: '777777', fillColor: '00000000', width: 1}), {}, 'GAUL districts in study area', false);
Map.addLayer(worldCoverCropland, {palette: ['74a57f']}, 'Cropland mask - ESA WorldCover class 40', false);
Map.addLayer(dynamicCropland, {palette: ['fdae61']}, 'Cropland support - dynamic vegetation threshold', false);
Map.addLayer(combinedCropland, {palette: ['2b8cbe']}, 'Cropland mask - combined final candidate', true);
print('Cropland mask area summary', maskAreaStats);

// ================================ EXPORTS =================================
if (RUN_EXPORTS) {
  Export.table.toDrive({
    collection: ee.FeatureCollection([ee.Feature(studyArea, {
      boundary_name: 'indus_basin_pakistan_study_area',
      source: ee.Algorithms.If(USE_CUSTOM_STUDY_AREA_ASSET, CUSTOM_STUDY_AREA_ASSET, 'WWF/HydroSHEDS/v1/Basins/hybas_5 + FAO GAUL Pakistan'),
      hydrobasins_main_bas: INDUS_MAIN_BAS,
      unit: 'geometry'
    })]),
    description: 'indus_basin_pakistan_study_area_boundary',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'indus_basin_pakistan_study_area_boundary',
    fileFormat: 'GeoJSON'
  });

  Export.table.toDrive({
    collection: studyDistricts,
    description: 'indus_basin_pakistan_gaul_districts',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'indus_basin_pakistan_gaul_districts',
    fileFormat: 'CSV'
  });

  Export.table.toDrive({
    collection: maskAreaStats,
    description: 'cropland_mask_area_summary_' + ANALYSIS_YEAR,
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'cropland_mask_area_summary_' + ANALYSIS_YEAR,
    fileFormat: 'CSV'
  });

  Export.image.toDrive({
    image: worldCoverCropland,
    description: 'map_cropland_worldcover_class40_' + ANALYSIS_YEAR + '_unit_binary',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'map_cropland_worldcover_class40_' + ANALYSIS_YEAR + '_unit_binary',
    region: studyArea,
    scale: CROP_SCALE_M,
    crs: ANALYSIS_CRS,
    maxPixels: 1e13
  });

  Export.image.toDrive({
    image: dynamicCropland,
    description: 'map_cropland_dynamic_threshold_' + ANALYSIS_YEAR + '_unit_binary',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'map_cropland_dynamic_threshold_' + ANALYSIS_YEAR + '_unit_binary',
    region: studyArea,
    scale: CROP_SCALE_M,
    crs: ANALYSIS_CRS,
    maxPixels: 1e13
  });

  Export.image.toDrive({
    image: combinedCropland,
    description: 'map_cropland_combined_' + CROPLAND_STRATEGY + '_' + ANALYSIS_YEAR + '_unit_binary',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'map_cropland_combined_' + CROPLAND_STRATEGY + '_' + ANALYSIS_YEAR + '_unit_binary',
    region: studyArea,
    scale: CROP_SCALE_M,
    crs: ANALYSIS_CRS,
    maxPixels: 1e13
  });
}
