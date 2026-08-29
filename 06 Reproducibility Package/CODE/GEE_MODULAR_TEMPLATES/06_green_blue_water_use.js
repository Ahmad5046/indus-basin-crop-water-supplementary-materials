// 06 - Green and blue water use estimation

var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var RUN_EXPORTS = false;
var YEAR = 2023;
var SEASON = 'kharif';
var WATER_SCALE = 250;
var ANALYSIS_CRS = 'EPSG:32642';

var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0').filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');
var indusMainBas = ee.Number(ee.Feature(hydro5.filterBounds(ee.Geometry.Point([68.0, 24.5])).sort('UP_AREA', false).first()).get('MAIN_BAS'));
var studyArea = hydro5.filter(ee.Filter.eq('MAIN_BAS', indusMainBas)).geometry()
  .intersection(pakistan.geometry(), ee.ErrorMargin(1000));
var croplandMask = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map').eq(40).selfMask().clip(studyArea);

function seasonDates(year, season) {
  if (season === 'rabi') {
    return {start: ee.Date.fromYMD(year - 1, 11, 1), end: ee.Date.fromYMD(year, 5, 1)};
  }
  return {start: ee.Date.fromYMD(year, 5, 1), end: ee.Date.fromYMD(year, 12, 1)};
}

function aeti(year, season) {
  var d = seasonDates(year, season);
  return ee.ImageCollection('FAO/WAPOR/3/L1_AETI_D').filterBounds(studyArea).filterDate(d.start, d.end)
    .map(function(image) {
      var date = ee.Date(image.get('system:time_start'));
      var day = ee.Number.parse(date.format('d'));
      var monthStart = ee.Date.fromYMD(ee.Number.parse(date.format('Y')), ee.Number.parse(date.format('M')), 1);
      var nextMonthStart = monthStart.advance(1, 'month');
      var dekadEnd = ee.Date(ee.Algorithms.If(day.lt(21), date.advance(10, 'day'), nextMonthStart));
      var clippedEnd = ee.Date(ee.Algorithms.If(dekadEnd.millis().gt(d.end.millis()), d.end, dekadEnd));
      var days = clippedEnd.difference(date, 'day').max(0);
      return image.select('L1-AETI-D').multiply(0.1).multiply(days).rename('aeti_mm').toFloat();
    }).sum().rename('aeti_mm').updateMask(croplandMask).clip(studyArea);
}

function effectiveRain(year, season) {
  var d = seasonDates(year, season);
  var nMonths = d.end.difference(d.start, 'month').round();
  return ee.ImageCollection.fromImages(ee.List.sequence(0, nMonths.subtract(1)).map(function(offset) {
    var mStart = d.start.advance(ee.Number(offset), 'month');
    var rawEnd = mStart.advance(1, 'month');
    var mEnd = ee.Date(ee.Algorithms.If(rawEnd.millis().gt(d.end.millis()), d.end, rawEnd));
    var p = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY').filterDate(mStart, mEnd).filterBounds(studyArea).select('precipitation').sum();
    var peffLow = p.multiply(ee.Image.constant(125).subtract(p.multiply(0.2))).divide(125);
    var peffHigh = p.multiply(0.1).add(125);
    return peffLow.where(p.gt(250), peffHigh).max(0).rename('effective_rainfall_mm').toFloat();
  })).sum().rename('effective_rainfall_mm').updateMask(croplandMask).clip(studyArea);
}

var total = aeti(YEAR, SEASON).rename('total_crop_water_use_mm');
var peff = effectiveRain(YEAR, SEASON);
var green = total.min(peff).rename('green_water_mm');
var blue = total.subtract(green).max(0).rename('blue_water_mm');
var water = total.addBands(green).addBands(blue).addBands(peff);

Map.centerObject(studyArea, 6);
Map.addLayer(green, {min: 0, max: 500, palette: ['#ffffcc', '#78c679', '#006837']}, 'Green water use mm');
Map.addLayer(blue, {min: 0, max: 500, palette: ['#f7fbff', '#6baed6', '#08306b']}, 'Blue water use mm');

if (RUN_EXPORTS) {
  Export.image.toDrive({image: water, description: 'green_blue_total_water_use_' + SEASON + '_' + YEAR, folder: EXPORT_FOLDER, fileNamePrefix: 'green_blue_total_water_use_' + SEASON + '_' + YEAR, region: studyArea, scale: WATER_SCALE, crs: ANALYSIS_CRS, maxPixels: 1e13});
}
