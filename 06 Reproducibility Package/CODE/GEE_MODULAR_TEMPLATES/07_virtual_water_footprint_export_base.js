// 07 - Virtual water footprint export base
// Final VWF is calculated after export by merging this table with official crop yield/production statistics.

var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var RUN_EXPORTS = false;
var YEAR = 2023;
var SEASON = 'kharif';
var WATER_SCALE = 250;
var ANALYSIS_CRS = 'EPSG:32642';
var USE_CROP_MAP = false;
var CROP_MAP_ASSET = 'users/YOUR_USERNAME/crop_classification_2023';

// If USE_CROP_MAP is false, the export is all-cropland only and crop_code = 0.
var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0').filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var districts = ee.FeatureCollection('FAO/GAUL/2015/level2').filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');
var indusMainBas = ee.Number(ee.Feature(hydro5.filterBounds(ee.Geometry.Point([68.0, 24.5])).sort('UP_AREA', false).first()).get('MAIN_BAS'));
var studyArea = hydro5.filter(ee.Filter.eq('MAIN_BAS', indusMainBas)).geometry().intersection(pakistan.geometry(), ee.ErrorMargin(1000));
var studyDistricts = districts.filterBounds(studyArea);
var croplandMask = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map').eq(40).selfMask().clip(studyArea);
var cropMap = USE_CROP_MAP ? ee.Image(CROP_MAP_ASSET).rename('crop_code') : ee.Image(0).rename('crop_code').updateMask(croplandMask);

// To keep this script focused, import green_blue_total_water_use_* as an asset or paste the functions from script 06.
// Expected water bands: green_water_mm, blue_water_mm, total_crop_water_use_mm.
var WATER_IMAGE_ASSET = 'users/YOUR_USERNAME/green_blue_total_water_use_kharif_2023';
var water = ee.Image(WATER_IMAGE_ASSET);

var pixelArea = ee.Image.pixelArea();
var cropCodes = USE_CROP_MAP ? ee.List([1, 2, 3, 4, 5]) : ee.List([0]);

var rows = ee.FeatureCollection(cropCodes.map(function(code) {
  code = ee.Number(code);
  var mask = USE_CROP_MAP ? cropMap.eq(code) : croplandMask;
  var volume = ee.Image.cat([
    pixelArea.divide(10000).rename('mapped_area_ha'),
    water.select('green_water_mm').multiply(pixelArea).multiply(0.001).rename('green_water_m3'),
    water.select('blue_water_mm').multiply(pixelArea).multiply(0.001).rename('blue_water_m3'),
    water.select('total_crop_water_use_mm').multiply(pixelArea).multiply(0.001).rename('total_crop_water_m3')
  ]).updateMask(mask);
  return volume.reduceRegions({
    collection: studyDistricts,
    reducer: ee.Reducer.sum(),
    scale: WATER_SCALE,
    crs: ANALYSIS_CRS,
    tileScale: 4
  }).map(function(feature) {
    return feature.set({year: YEAR, season: SEASON, crop_code: code});
  });
})).flatten();

print('Export base table for VWF post-processing', rows.limit(5));

if (RUN_EXPORTS) {
  Export.table.toDrive({
    collection: rows,
    description: 'district_crop_water_use_for_vwf_' + SEASON + '_' + YEAR,
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'district_crop_water_use_for_vwf_' + SEASON + '_' + YEAR,
    fileFormat: 'CSV'
  });
}
