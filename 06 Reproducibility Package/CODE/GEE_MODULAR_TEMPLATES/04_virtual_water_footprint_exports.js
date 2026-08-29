// 04_virtual_water_footprint_exports.js
// Virtual water footprint (VWF) and water productivity exports.
//
// This script requires official crop yield/production data as a GEE table asset
// for final VWF. It never hard-codes fake yields. If the yield asset is missing,
// set RUN_EXPORTS = true to export a district-crop yield input template CSV.

// ============================= USER SETTINGS ==============================
var RUN_EXPORTS = false;
var USE_VALIDATED_SEASONAL_CROP_ASSETS = true;
var RABI_CROP_MAP_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/crop_classification_rabi_2023_30m';
var KHARIF_CROP_MAP_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/crop_classification_kharif_2023_30m';
var USE_YIELD_TABLE_ASSET = true;
var YIELD_TABLE_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/official_district_crop_statistics_2022_23_gaul2024';
var GAUL2024_DISTRICTS_ASSET = 'projects/ee-muhammandahmad158609/assets/indus_vwf_2023/fao_gaul_2024_pak_adm2_karachi_aggregate';
var KARACHI_COMPONENT_CODES = ['130204', '130206', '130214', '130216', '130223', '130231'];
var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var YEARS = [2023];
var ANALYSIS_CRS = 'EPSG:32642';
var WATER_SCALE_M = 250;
var INDUS_MAIN_BAS = 4050033640;

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

// ========================== WATER-USE FUNCTIONS ===========================
function cropDates(year, crop) {
  var start = ee.Date.fromYMD(year + crop.startYearOffset, crop.startMonth, crop.startDay);
  var end = ee.Date.fromYMD(year + crop.endYearOffset, crop.endMonth, crop.endDay).advance(1, 'day');
  return {start: start, end: end};
}

function waporAetiSeason(start, end, mask) {
  function perDekad(image) {
    var date = ee.Date(image.get('system:time_start'));
    var day = ee.Number.parse(date.format('d'));
    var monthStart = ee.Date.fromYMD(ee.Number.parse(date.format('Y')), ee.Number.parse(date.format('M')), 1);
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

function effectiveRainSeason(start, end, mask) {
  var nMonths = end.advance(-1, 'day').difference(start, 'month').floor().add(1);
  return ee.ImageCollection.fromImages(ee.List.sequence(0, nMonths.subtract(1)).map(function(offset) {
    var monthStart = start.advance(ee.Number(offset), 'month');
    var rawEnd = monthStart.advance(1, 'month');
    var monthEnd = ee.Date(ee.Algorithms.If(rawEnd.millis().gt(end.millis()), end, rawEnd));
    var p = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
      .filterBounds(studyArea)
      .filterDate(monthStart, monthEnd)
      .select('precipitation')
      .sum();
    var peffLow = p.multiply(ee.Image.constant(125).subtract(p.multiply(0.2))).divide(125);
    var peffHigh = p.multiply(0.1).add(125);
    return peffLow.where(p.gt(250), peffHigh).max(0).rename('effective_rainfall_mm').toFloat();
  })).sum().rename('effective_rainfall_mm').updateMask(mask).clip(studyArea);
}

function waterUseImage(year, crop) {
  var d = cropDates(year, crop);
  var mask = cropMaskFor(crop);
  var total = waporAetiSeason(d.start, d.end, mask).rename('total_crop_water_use_mm');
  var peff = effectiveRainSeason(d.start, d.end, mask);
  var green = total.min(peff).rename('green_water_mm');
  var blue = total.subtract(green).max(0).rename('blue_water_mm');
  return ee.Image.cat([total, green, blue]).toFloat().updateMask(mask).clip(studyArea);
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
    return addJoinKey(feature.set({
      year: year,
      crop_code: crop.code,
      crop_name: crop.name,
      season: crop.season,
      start_date: d.start.format('YYYY-MM-dd'),
      end_date: d.end.advance(-1, 'day').format('YYYY-MM-dd'),
      area_unit: 'ha',
      volume_unit: 'm3 season-1',
      vwf_unit: 'm3 t-1',
      water_productivity_unit: 'kg m-3',
      crop_mask_source: ee.Algorithms.If(USE_VALIDATED_SEASONAL_CROP_ASSETS, RABI_CROP_MAP_ASSET + '; ' + KHARIF_CROP_MAP_ASSET, 'all cropland preliminary')
    }));
  });
}

// ============================ YIELD JOIN/VWF ==============================
function addJoinKey(feature) {
  var year = ee.Number(feature.get('year')).format('%d');
  var season = ee.String(feature.get('season'));
  var adm2 = ee.String(feature.get('gaul2_code'));
  var crop = ee.Number(feature.get('crop_code')).format('%d');
  return feature.set('join_key', year.cat('_').cat(season).cat('_').cat(adm2).cat('_').cat(crop));
}

function buildWaterTable() {
  var all = ee.FeatureCollection([]);
  YEARS.forEach(function(year) {
    CROPS.forEach(function(crop) {
      all = all.merge(districtWaterTable(year, crop));
    });
  });
  return all;
}

function buildYieldTemplate() {
  var template = ee.FeatureCollection([]);
  YEARS.forEach(function(year) {
    CROPS.forEach(function(crop) {
      var rows = studyDistricts.map(function(district) {
        return addJoinKey(district.set({
          year: year,
          season: crop.season,
          crop_code: crop.code,
          crop_name: crop.name,
          yield_t_ha: '',
          production_t: '',
          harvested_area_ha: '',
          source_name: '',
          source_url: '',
          notes: 'Replace zeros with official numeric values. Use production_t if available; otherwise yield_t_ha times mapped area is used.'
        }));
      });
      template = template.merge(rows);
    });
  });
  return template;
}

function joinYieldAndComputeVwf(waterTable, yieldTable) {
  var keyedYield = yieldTable.map(addJoinKey);
  var joined = ee.Join.saveFirst('yield_record').apply({
    primary: waterTable,
    secondary: keyedYield,
    condition: ee.Filter.equals({leftField: 'join_key', rightField: 'join_key'})
  });

  return ee.FeatureCollection(joined).map(function(feature) {
    var missingYield = ee.Algorithms.IsEqual(feature.get('yield_record'), null);
    var empty = ee.Feature(null, {
      yield_t_ha: 0,
      production_t: 0,
      source_name: '',
      source_url: ''
    });
    var yieldRecord = ee.Feature(ee.Algorithms.If(missingYield, empty, feature.get('yield_record')));
    var yieldTHa = ee.Number(ee.Algorithms.If(missingYield, 0, yieldRecord.get('yield_t_ha')));
    var productionTInput = ee.Number(ee.Algorithms.If(missingYield, 0, yieldRecord.get('production_t')));
    var mappedAreaHa = ee.Number(feature.get('mapped_area_ha'));
    var productionFromYield = yieldTHa.multiply(mappedAreaHa);
    var productionT = ee.Number(ee.Algorithms.If(productionTInput.gt(0), productionTInput, productionFromYield));
    var validProduction = productionT.gt(0);
    var greenM3 = ee.Number(feature.get('green_water_m3'));
    var blueM3 = ee.Number(feature.get('blue_water_m3'));
    var totalM3 = ee.Number(feature.get('total_crop_water_m3'));
    return feature.set({
      yield_t_ha: yieldTHa,
      production_t_input: productionTInput,
      production_basis_t: productionT,
      green_vwf_m3_t: ee.Algorithms.If(validProduction, greenM3.divide(productionT), null),
      blue_vwf_m3_t: ee.Algorithms.If(validProduction, blueM3.divide(productionT), null),
      total_vwf_m3_t: ee.Algorithms.If(validProduction, totalM3.divide(productionT), null),
      water_productivity_kg_m3: ee.Algorithms.If(validProduction, productionT.multiply(1000).divide(totalM3), null),
      blue_water_productivity_kg_m3: ee.Algorithms.If(validProduction, ee.Algorithms.If(blueM3.gt(0), productionT.multiply(1000).divide(blueM3), null), null),
      vwf_status: ee.Algorithms.If(validProduction, 'computed_from_user_uploaded_official_yield_table', 'not_computed_missing_valid_yield_or_production'),
      yield_source_name: yieldRecord.get('source_name'),
      yield_source_url: yieldRecord.get('source_url')
    });
  });
}

// ============================ MAPS AND EXPORTS ============================
var waterTable = buildWaterTable();
var yieldTemplate = buildYieldTemplate();
var vwfTable = USE_YIELD_TABLE_ASSET
  ? joinYieldAndComputeVwf(waterTable, ee.FeatureCollection(YIELD_TABLE_ASSET))
  : waterTable.map(function(f) {
    return f.set({
      vwf_status: 'not_computed_yield_table_missing',
      yield_t_ha: '',
      production_basis_t: '',
      green_vwf_m3_t: '',
      blue_vwf_m3_t: '',
      total_vwf_m3_t: '',
      water_productivity_kg_m3: '',
      blue_water_productivity_kg_m3: ''
    });
  });

print('Water table preview', waterTable.limit(5));
print('Yield input template preview', yieldTemplate.limit(5));
print('VWF table preview', vwfTable.limit(5));

Map.centerObject(studyArea, 6);
Map.addLayer(croplandMask, {palette: ['74a57f']}, 'Cropland mask', false);

// Export maps only when crop map and yield table are available. VWF maps cannot
// be defensibly rasterized without official yield/production data.
if (RUN_EXPORTS) {
  Export.table.toDrive({
    collection: yieldTemplate,
    description: 'template_district_crop_yield_input_for_vwf',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'template_district_crop_yield_input_for_vwf',
    fileFormat: 'CSV'
  });

  Export.table.toDrive({
    collection: waterTable,
    description: 'table_district_crop_water_use_for_vwf_unit_m3',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'table_district_crop_water_use_for_vwf_unit_m3',
    fileFormat: 'CSV'
  });

  Export.table.toDrive({
    collection: vwfTable,
    description: 'table_district_crop_virtual_water_footprint_unit_m3_per_t',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'table_district_crop_virtual_water_footprint_unit_m3_per_t',
    fileFormat: 'CSV'
  });

  if (USE_YIELD_TABLE_ASSET && USE_VALIDATED_SEASONAL_CROP_ASSETS) {
    YEARS.forEach(function(year) {
      CROPS.forEach(function(crop) {
        var rows = vwfTable
          .filter(ee.Filter.eq('year', year))
          .filter(ee.Filter.eq('crop_code', crop.code))
          .filter(ee.Filter.eq('vwf_status', 'computed_from_user_uploaded_official_yield_table'));
        var cropMask = cropMaskFor(crop);
        var tag = crop.name.toLowerCase() + '_' + crop.season + '_' + year;

        var greenVwfMap = ee.Image().float().paint(rows, 'green_vwf_m3_t')
          .rename('green_vwf_m3_t').updateMask(cropMask).clip(studyArea)
          .set({year: year, crop_code: crop.code, crop_name: crop.name, unit: 'm3 t-1'});
        var blueVwfMap = ee.Image().float().paint(rows, 'blue_vwf_m3_t')
          .rename('blue_vwf_m3_t').updateMask(cropMask).clip(studyArea)
          .set({year: year, crop_code: crop.code, crop_name: crop.name, unit: 'm3 t-1'});
        var totalVwfMap = ee.Image().float().paint(rows, 'total_vwf_m3_t')
          .rename('total_vwf_m3_t').updateMask(cropMask).clip(studyArea)
          .set({year: year, crop_code: crop.code, crop_name: crop.name, unit: 'm3 t-1'});
        var wpMap = ee.Image().float().paint(rows, 'water_productivity_kg_m3')
          .rename('water_productivity_kg_m3').updateMask(cropMask).clip(studyArea)
          .set({year: year, crop_code: crop.code, crop_name: crop.name, unit: 'kg m-3'});
        var blueWpMap = ee.Image().float().paint(rows, 'blue_water_productivity_kg_m3')
          .rename('blue_water_productivity_kg_m3').updateMask(cropMask).clip(studyArea)
          .set({year: year, crop_code: crop.code, crop_name: crop.name, unit: 'kg m-3'});

        Export.image.toDrive({
          image: greenVwfMap,
          description: 'map_green_virtual_water_footprint_' + tag + '_unit_m3_per_t',
          folder: EXPORT_FOLDER,
          fileNamePrefix: 'map_green_virtual_water_footprint_' + tag + '_unit_m3_per_t',
          region: studyArea,
          scale: WATER_SCALE_M,
          crs: ANALYSIS_CRS,
          maxPixels: 1e13
        });

        Export.image.toDrive({
          image: blueVwfMap,
          description: 'map_blue_virtual_water_footprint_' + tag + '_unit_m3_per_t',
          folder: EXPORT_FOLDER,
          fileNamePrefix: 'map_blue_virtual_water_footprint_' + tag + '_unit_m3_per_t',
          region: studyArea,
          scale: WATER_SCALE_M,
          crs: ANALYSIS_CRS,
          maxPixels: 1e13
        });

        Export.image.toDrive({
          image: totalVwfMap,
          description: 'map_total_virtual_water_footprint_' + tag + '_unit_m3_per_t',
          folder: EXPORT_FOLDER,
          fileNamePrefix: 'map_total_virtual_water_footprint_' + tag + '_unit_m3_per_t',
          region: studyArea,
          scale: WATER_SCALE_M,
          crs: ANALYSIS_CRS,
          maxPixels: 1e13
        });

        Export.image.toDrive({
          image: wpMap,
          description: 'map_water_productivity_' + tag + '_unit_kg_per_m3',
          folder: EXPORT_FOLDER,
          fileNamePrefix: 'map_water_productivity_' + tag + '_unit_kg_per_m3',
          region: studyArea,
          scale: WATER_SCALE_M,
          crs: ANALYSIS_CRS,
          maxPixels: 1e13
        });

        Export.image.toDrive({
          image: blueWpMap,
          description: 'map_blue_water_productivity_' + tag + '_unit_kg_per_m3',
          folder: EXPORT_FOLDER,
          fileNamePrefix: 'map_blue_water_productivity_' + tag + '_unit_kg_per_m3',
          region: studyArea,
          scale: WATER_SCALE_M,
          crs: ANALYSIS_CRS,
          maxPixels: 1e13
        });
      });
    });
  }
}
