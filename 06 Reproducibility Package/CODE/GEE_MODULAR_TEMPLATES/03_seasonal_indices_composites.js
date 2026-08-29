// 03 - Seasonal NDVI, EVI, NDWI, and LSWI composites from Sentinel-2 SR Harmonized

var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var RUN_EXPORTS = false;
var YEAR = 2023;
var ANALYSIS_CRS = 'EPSG:32642';
var EXPORT_SCALE = 30;

var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0').filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');
var indusMainBas = ee.Number(ee.Feature(hydro5.filterBounds(ee.Geometry.Point([68.0, 24.5])).sort('UP_AREA', false).first()).get('MAIN_BAS'));
var studyArea = hydro5.filter(ee.Filter.eq('MAIN_BAS', indusMainBas)).geometry()
  .intersection(pakistan.geometry(), ee.ErrorMargin(1000));
var croplandMask = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map').eq(40).selfMask().clip(studyArea);

function maskS2sr(image) {
  var scl = image.select('SCL');
  var valid = scl.neq(3).and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
  return image.select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12']).divide(10000)
    .updateMask(valid)
    .copyProperties(image, ['system:time_start']);
}

function addIndices(image) {
  var ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI');
  var ndwi = image.normalizedDifference(['B3', 'B8']).rename('NDWI');
  var lswi = image.normalizedDifference(['B8', 'B11']).rename('LSWI');
  var evi = image.expression(
    '2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))',
    {NIR: image.select('B8'), RED: image.select('B4'), BLUE: image.select('B2')}
  ).rename('EVI');
  return image.addBands([ndvi, evi, ndwi, lswi]);
}

function composite(start, end, prefix) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(studyArea)
    .filterDate(start, end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 70))
    .map(maskS2sr)
    .map(addIndices)
    .select(['NDVI', 'EVI', 'NDWI', 'LSWI'])
    .median()
    .rename([prefix + '_NDVI', prefix + '_EVI', prefix + '_NDWI', prefix + '_LSWI'])
    .updateMask(croplandMask)
    .clip(studyArea);
}

var kharif = composite(YEAR + '-05-01', YEAR + '-12-01', 'kharif');
var rabi = composite((YEAR - 1) + '-11-01', YEAR + '-05-01', 'rabi');
var stack = kharif.addBands(rabi);

Map.centerObject(studyArea, 6);
Map.addLayer(kharif.select('kharif_NDVI'), {min: 0, max: 0.8, palette: ['#f2f0d7', '#8cc084', '#20603d']}, 'Kharif NDVI');
Map.addLayer(rabi.select('rabi_NDVI'), {min: 0, max: 0.8, palette: ['#f2f0d7', '#8cc084', '#20603d']}, 'Rabi NDVI', false);

if (RUN_EXPORTS) {
  Export.image.toDrive({
    image: stack,
    description: 'seasonal_indices_sentinel2_' + YEAR,
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'seasonal_indices_sentinel2_' + YEAR,
    region: studyArea,
    scale: EXPORT_SCALE,
    crs: ANALYSIS_CRS,
    maxPixels: 1e13
  });
}
