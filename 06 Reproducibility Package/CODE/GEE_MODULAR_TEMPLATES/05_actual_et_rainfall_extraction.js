// 05 - Actual evapotranspiration and rainfall extraction

var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var RUN_EXPORTS = false;
var YEAR = 2023;
var SEASON = 'kharif';
var WATER_SCALE = 250;
var ANALYSIS_CRS = 'EPSG:32642';

var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0').filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var districts = ee.FeatureCollection('FAO/GAUL/2015/level2').filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');
var indusMainBas = ee.Number(ee.Feature(hydro5.filterBounds(ee.Geometry.Point([68.0, 24.5])).sort('UP_AREA', false).first()).get('MAIN_BAS'));
var studyArea = hydro5.filter(ee.Filter.eq('MAIN_BAS', indusMainBas)).geometry()
  .intersection(pakistan.geometry(), ee.ErrorMargin(1000));
var studyDistricts = districts.filterBounds(studyArea);
var croplandMask = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map').eq(40).selfMask().clip(studyArea);

function seasonDates(year, season) {
  if (season === 'rabi') {
    return {start: ee.Date.fromYMD(year - 1, 11, 1), end: ee.Date.fromYMD(year, 5, 1)};
  }
  return {start: ee.Date.fromYMD(year, 5, 1), end: ee.Date.fromYMD(year, 12, 1)};
}

function waporAetiSeason(year, season) {
  var d = seasonDates(year, season);
  return ee.ImageCollection('FAO/WAPOR/3/L1_AETI_D')
    .filterBounds(studyArea)
    .filterDate(d.start, d.end)
    .map(function(image) {
      var date = ee.Date(image.get('system:time_start'));
      var day = ee.Number.parse(date.format('d'));
      var monthStart = ee.Date.fromYMD(ee.Number.parse(date.format('Y')), ee.Number.parse(date.format('M')), 1);
      var nextMonthStart = monthStart.advance(1, 'month');
      var dekadEnd = ee.Date(ee.Algorithms.If(day.lt(21), date.advance(10, 'day'), nextMonthStart));
      var clippedEnd = ee.Date(ee.Algorithms.If(dekadEnd.millis().gt(d.end.millis()), d.end, dekadEnd));
      var days = clippedEnd.difference(date, 'day').max(0);
      return image.select('L1-AETI-D').multiply(0.1).multiply(days).rename('aeti_mm').toFloat();
    })
    .sum()
    .rename('aeti_mm')
    .updateMask(croplandMask)
    .clip(studyArea);
}

function chirpsRainSeason(year, season) {
  var d = seasonDates(year, season);
  return ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
    .filterBounds(studyArea)
    .filterDate(d.start, d.end)
    .select('precipitation')
    .sum()
    .rename('rainfall_mm')
    .clip(studyArea);
}

var aeti = waporAetiSeason(YEAR, SEASON);
var rainfall = chirpsRainSeason(YEAR, SEASON);
var table = aeti.addBands(rainfall).reduceRegions({
  collection: studyDistricts,
  reducer: ee.Reducer.mean(),
  scale: WATER_SCALE,
  crs: ANALYSIS_CRS,
  tileScale: 4
}).map(function(f) {
  return f.set({year: YEAR, season: SEASON, unit: 'mm'});
});

Map.centerObject(studyArea, 6);
Map.addLayer(aeti, {min: 0, max: 900, palette: ['#f7fcf5', '#74c476', '#00441b']}, 'WaPOR AETI mm');
Map.addLayer(rainfall, {min: 0, max: 900, palette: ['#ffffcc', '#41b6c4', '#253494']}, 'CHIRPS rainfall mm', false);
print('District ET/rainfall preview', table.limit(5));

if (RUN_EXPORTS) {
  Export.image.toDrive({image: aeti, description: 'aeti_' + SEASON + '_' + YEAR, folder: EXPORT_FOLDER, fileNamePrefix: 'aeti_' + SEASON + '_' + YEAR, region: studyArea, scale: WATER_SCALE, crs: ANALYSIS_CRS, maxPixels: 1e13});
  Export.image.toDrive({image: rainfall, description: 'rainfall_' + SEASON + '_' + YEAR, folder: EXPORT_FOLDER, fileNamePrefix: 'rainfall_' + SEASON + '_' + YEAR, region: studyArea, scale: WATER_SCALE, crs: ANALYSIS_CRS, maxPixels: 1e13});
  Export.table.toDrive({collection: table, description: 'district_aeti_rainfall_' + SEASON + '_' + YEAR, folder: EXPORT_FOLDER, fileNamePrefix: 'district_aeti_rainfall_' + SEASON + '_' + YEAR, fileFormat: 'CSV'});
}
