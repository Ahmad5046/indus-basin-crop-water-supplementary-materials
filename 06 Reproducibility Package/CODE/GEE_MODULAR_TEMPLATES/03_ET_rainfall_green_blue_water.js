// 03_ET_rainfall_green_blue_water.js
// Crop-specific seasonal AETI, CHIRPS rainfall, effective rainfall, green
// water, blue water, total crop water use, and district/crop CSV exports.
//
// Requires a validated crop classification asset for crop-specific outputs.
// If no crop map is supplied, the script can export all-cropland preliminary
// water-use products without pretending they are crop-specific.

// ============================= USER SETTINGS ==============================
var RUN_EXPORTS = false;
var USE_VALIDATED_SEASONAL_CROP_ASSETS = true;
var RABI_CROP_MAP_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/crop_classification_rabi_2023_30m';
var KHARIF_CROP_MAP_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/crop_classification_kharif_2023_30m';
var GAUL2024_DISTRICTS_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/fao_gaul_2024_pak_adm2_karachi_aggregate';
var KARACHI_COMPONENT_CODES = ['130204', '130206', '130214', '130216', '130223', '130231'];
var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var YEARS = [2023];
var ANALYSIS_CRS = 'EPSG:32642';
var WATER_SCALE_M = 250;
var INDUS_MAIN_BAS = 4050033640;

// Effective rainfall method:
// USDA/SCS monthly approximation:
// Peff = P*(125 - 0.2P)/125 for P <= 250 mm; Peff = 125 + 0.1P for P > 250 mm.
var EFFECTIVE_RAIN_METHOD = 'USDA_SCS_monthly';

var CROPS = [
  {code: 1, name: 'Wheat', season: 'rabi', startMonth: 11, startDay: 1, startYearOffset: -1, endMonth: 4, endDay: 30, endYearOffset: 0},
  {code: 2, name: 'Rice', season: 'kharif', startMonth: 6, startDay: 1, startYearOffset: 0, endMonth: 10, endDay: 31, endYearOffset: 0},
  {code: 3, name: 'Cotton', season: 'kharif', startMonth: 4, startDay: 1, startYearOffset: 0, endMonth: 11, endDay: 30, endYearOffset: 0},
  {code: 4, name: 'Sugarcane', season: 'annual', startMonth: 1, startDay: 1, startYearOffset: 0, endMonth: 12, endDay: 31, endYearOffset: 0},
  {code: 5, name: 'Maize', season: 'spring_autumn', startMonth: 2, startDay: 1, startYearOffset: 0, endMonth: 11, endDay: 30, endYearOffset: 0}
];

// ============================= STUDY AREA/MASK ============================
var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0').filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var districts = ee.FeatureCollection(GAUL2024_DISTRICTS_ASSET)
  .filter(ee.Filter.inList('gaul2_code', KARACHI_COMPONENT_CODES).not());
var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');
var studyArea = hydro5.filter(ee.Filter.eq('MAIN_BAS', INDUS_MAIN_BAS)).geometry()
  .intersection(pakistan.geometry(), ee.ErrorMargin(1000));
var studyDistricts = districts.filterBounds(studyArea);
var croplandMask = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map')
  .eq(40).selfMask().rename('cropland').clip(studyArea);
var rabiCropMap = ee.Image(RABI_CROP_MAP_ASSET).select('crop_class').clip(studyArea);
var kharifCropMap = ee.Image(KHARIF_CROP_MAP_ASSET).select('crop_class').clip(studyArea);

function cropMaskFor(crop) {
  if (!USE_VALIDATED_SEASONAL_CROP_ASSETS) return croplandMask;
  if (crop.code === 1) return rabiCropMap.eq(crop.code).selfMask();
  if (crop.code === 2 || crop.code === 3) return kharifCropMap.eq(crop.code).selfMask();
  return rabiCropMap.eq(crop.code).or(kharifCropMap.eq(crop.code)).selfMask();
}

// ============================= DATE UTILITIES =============================
function cropDates(year, crop) {
  var start = ee.Date.fromYMD(year + crop.startYearOffset, crop.startMonth, crop.startDay);
  var end = ee.Date.fromYMD(year + crop.endYearOffset, crop.endMonth, crop.endDay).advance(1, 'day');
  return {start: start, end: end};
}

// ============================== ET/RAINFALL ===============================
function waporAetiSeason(start, end, mask) {
  // WaPOR L1-AETI-D is dekadal. Catalog scale factor is 0.1. We multiply the
  // daily-rate value by the number of days represented in each dekad and sum.
  function perDekad(image) {
    var date = ee.Date(image.get('system:time_start'));
    var day = ee.Number.parse(date.format('d'));
    var monthStart = ee.Date.fromYMD(
      ee.Number.parse(date.format('Y')),
      ee.Number.parse(date.format('M')),
      1
    );
    var nextMonthStart = monthStart.advance(1, 'month');
    var dekadEnd = ee.Date(ee.Algorithms.If(day.lt(21), date.advance(10, 'day'), nextMonthStart));
    var clippedStart = ee.Date(ee.Algorithms.If(date.millis().lt(start.millis()), start, date));
    var clippedEnd = ee.Date(ee.Algorithms.If(dekadEnd.millis().gt(end.millis()), end, dekadEnd));
    var days = clippedEnd.difference(clippedStart, 'day').max(0);
    return image.select('L1-AETI-D').multiply(0.1).multiply(days).rename('aeti_mm').toFloat();
  }

  return ee.ImageCollection('FAO/WAPOR/3/L1_AETI_D')
    .filterBounds(studyArea)
    .filterDate(start, end)
    .map(perDekad)
    .sum()
    .rename('aeti_mm')
    .updateMask(mask)
    .clip(studyArea);
}

function chirpsRainSeason(start, end, mask) {
  return ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
    .filterBounds(studyArea)
    .filterDate(start, end)
    .select('precipitation')
    .sum()
    .rename('rainfall_mm')
    .updateMask(mask)
    .clip(studyArea);
}

function effectiveRainSeason(start, end, mask) {
  var nMonths = end.advance(-1, 'day').difference(start, 'month').floor().add(1);
  var monthly = ee.ImageCollection.fromImages(ee.List.sequence(0, nMonths.subtract(1)).map(function(offset) {
    offset = ee.Number(offset);
    var monthStart = start.advance(offset, 'month');
    var rawEnd = monthStart.advance(1, 'month');
    var monthEnd = ee.Date(ee.Algorithms.If(rawEnd.millis().gt(end.millis()), end, rawEnd));
    var p = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
      .filterBounds(studyArea)
      .filterDate(monthStart, monthEnd)
      .select('precipitation')
      .sum()
      .rename('monthly_rainfall_mm');
    var peffLow = p.multiply(ee.Image.constant(125).subtract(p.multiply(0.2))).divide(125);
    var peffHigh = p.multiply(0.1).add(125);
    return peffLow.where(p.gt(250), peffHigh).max(0).rename('effective_rainfall_mm').toFloat();
  }));
  return monthly.sum().rename('effective_rainfall_mm').updateMask(mask).clip(studyArea);
}

function waterUseImage(year, crop) {
  var d = cropDates(year, crop);
  var mask = cropMaskFor(crop);
  var aeti = waporAetiSeason(d.start, d.end, mask).rename('total_crop_water_use_mm');
  var rainfall = chirpsRainSeason(d.start, d.end, mask);
  var effectiveRain = effectiveRainSeason(d.start, d.end, mask);
  var green = aeti.min(effectiveRain).rename('green_water_mm');
  var blue = aeti.subtract(green).max(0).rename('blue_water_mm');
  var greenPct = green.divide(aeti).multiply(100).rename('green_water_pct');
  var bluePct = blue.divide(aeti).multiply(100).rename('blue_dependency_pct');
  return ee.Image.cat([aeti, rainfall, effectiveRain, green, blue, greenPct, bluePct]).toFloat()
    .updateMask(mask)
    .clip(studyArea)
    .set({
      year: year,
      crop_code: crop.code,
      crop_name: crop.name,
      season: crop.season,
      start_date: d.start.format('YYYY-MM-dd'),
      end_date: d.end.advance(-1, 'day').format('YYYY-MM-dd'),
      depth_unit: 'mm season-1',
      source_aeti: 'FAO/WAPOR/3/L1_AETI_D',
      source_rainfall: 'UCSB-CHG/CHIRPS/DAILY',
      effective_rainfall_method: EFFECTIVE_RAIN_METHOD,
      notes: ee.Algorithms.If(USE_VALIDATED_SEASONAL_CROP_ASSETS, 'Crop-specific mask from validated seasonal RF assets.', 'All-cropland preliminary mask; not crop-specific.')
    });
}

function districtWaterTable(year, crop) {
  var water = waterUseImage(year, crop);
  var area = ee.Image.pixelArea();
  var volumeImage = ee.Image.cat([
    area.divide(10000).rename('mapped_area_ha'),
    water.select('green_water_mm').multiply(area).multiply(0.001).rename('green_water_m3'),
    water.select('blue_water_mm').multiply(area).multiply(0.001).rename('blue_water_m3'),
    water.select('total_crop_water_use_mm').multiply(area).multiply(0.001).rename('total_crop_water_m3')
  ]).updateMask(water.select('total_crop_water_use_mm').mask());

  var d = cropDates(year, crop);
  return volumeImage.reduceRegions({
    collection: studyDistricts,
    reducer: ee.Reducer.sum(),
    scale: WATER_SCALE_M,
    crs: ANALYSIS_CRS,
    tileScale: 4
  }).filter(ee.Filter.gt('mapped_area_ha', 0)).map(function(feature) {
    var areaHa = ee.Number(feature.get('mapped_area_ha'));
    var greenM3 = ee.Number(feature.get('green_water_m3'));
    var blueM3 = ee.Number(feature.get('blue_water_m3'));
    var totalM3 = ee.Number(feature.get('total_crop_water_m3'));
    var areaM2 = areaHa.multiply(10000);
    return feature.set({
      year: year,
      crop_code: crop.code,
      crop_name: crop.name,
      season: crop.season,
      start_date: d.start.format('YYYY-MM-dd'),
      end_date: d.end.advance(-1, 'day').format('YYYY-MM-dd'),
      area_unit: 'ha',
      volume_unit: 'm3 season-1',
      depth_unit: 'mm season-1',
      green_water_mm: greenM3.divide(areaM2).multiply(1000),
      blue_water_mm: blueM3.divide(areaM2).multiply(1000),
      total_crop_water_use_mm: totalM3.divide(areaM2).multiply(1000),
      source_aeti: 'FAO/WAPOR/3/L1_AETI_D',
      source_rainfall: 'UCSB-CHG/CHIRPS/DAILY',
      effective_rainfall_method: EFFECTIVE_RAIN_METHOD,
      crop_mask_source: ee.Algorithms.If(USE_VALIDATED_SEASONAL_CROP_ASSETS, RABI_CROP_MAP_ASSET + '; ' + KHARIF_CROP_MAP_ASSET, 'ESA WorldCover all cropland preliminary')
    });
  });
}

// ============================== MAP DISPLAY ===============================
Map.centerObject(studyArea, 6);
Map.addLayer(croplandMask, {palette: ['74a57f']}, 'Cropland mask - ESA WorldCover', false);

// Display first crop/year as an example layer.
var previewCrop = CROPS[0];
var previewYear = YEARS[0];
var previewWater = waterUseImage(previewYear, previewCrop);
Map.addLayer(previewWater.select('green_water_mm'), {min: 0, max: 500, palette: ['ffffcc', '78c679', '006837']}, 'Preview green water mm - ' + previewCrop.name + ' ' + previewYear, true);
Map.addLayer(previewWater.select('blue_water_mm'), {min: 0, max: 500, palette: ['f7fbff', '6baed6', '08306b']}, 'Preview blue water mm - ' + previewCrop.name + ' ' + previewYear, false);

// ================================ EXPORTS =================================
var allTables = ee.FeatureCollection([]);
YEARS.forEach(function(year) {
  CROPS.forEach(function(crop) {
    var water = waterUseImage(year, crop);
    var table = districtWaterTable(year, crop);
    allTables = allTables.merge(table);

    if (RUN_EXPORTS) {
      var tag = crop.name.toLowerCase() + '_' + crop.season + '_' + year;

      Export.image.toDrive({
        image: water.select('green_water_mm'),
        description: 'map_green_water_' + tag + '_unit_mm',
        folder: EXPORT_FOLDER,
        fileNamePrefix: 'map_green_water_' + tag + '_unit_mm',
        region: studyArea,
        scale: WATER_SCALE_M,
        crs: ANALYSIS_CRS,
        maxPixels: 1e13
      });

      Export.image.toDrive({
        image: water.select('blue_water_mm'),
        description: 'map_blue_water_' + tag + '_unit_mm',
        folder: EXPORT_FOLDER,
        fileNamePrefix: 'map_blue_water_' + tag + '_unit_mm',
        region: studyArea,
        scale: WATER_SCALE_M,
        crs: ANALYSIS_CRS,
        maxPixels: 1e13
      });

      Export.image.toDrive({
        image: water.select('total_crop_water_use_mm'),
        description: 'map_total_crop_water_use_' + tag + '_unit_mm',
        folder: EXPORT_FOLDER,
        fileNamePrefix: 'map_total_crop_water_use_' + tag + '_unit_mm',
        region: studyArea,
        scale: WATER_SCALE_M,
        crs: ANALYSIS_CRS,
        maxPixels: 1e13
      });

      Export.image.toDrive({
        image: water.select('rainfall_mm'),
        description: 'map_chirps_rainfall_' + tag + '_unit_mm',
        folder: EXPORT_FOLDER,
        fileNamePrefix: 'map_chirps_rainfall_' + tag + '_unit_mm',
        region: studyArea,
        scale: WATER_SCALE_M,
        crs: ANALYSIS_CRS,
        maxPixels: 1e13
      });

      Export.image.toDrive({
        image: water.select('green_water_pct'),
        description: 'map_green_water_percentage_' + tag + '_unit_percent',
        folder: EXPORT_FOLDER,
        fileNamePrefix: 'map_green_water_percentage_' + tag + '_unit_percent',
        region: studyArea,
        scale: WATER_SCALE_M,
        crs: ANALYSIS_CRS,
        maxPixels: 1e13
      });

      Export.image.toDrive({
        image: water.select('blue_dependency_pct'),
        description: 'map_blue_water_dependency_' + tag + '_unit_percent',
        folder: EXPORT_FOLDER,
        fileNamePrefix: 'map_blue_water_dependency_' + tag + '_unit_percent',
        region: studyArea,
        scale: WATER_SCALE_M,
        crs: ANALYSIS_CRS,
        maxPixels: 1e13
      });
    }
  });
});

print('District crop water-use table preview', allTables.limit(10));

if (RUN_EXPORTS) {
  Export.table.toDrive({
    collection: allTables,
    description: 'table_district_crop_green_blue_water_all_crops_unit_m3_mm',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'table_district_crop_green_blue_water_all_crops_unit_m3_mm',
    fileFormat: 'CSV'
  });
}
