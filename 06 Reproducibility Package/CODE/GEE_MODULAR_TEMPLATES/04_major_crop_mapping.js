// 04 - Major crop mapping with validated training samples
// This script requires a GEE FeatureCollection asset with crop_code labels.

var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var RUN_EXPORTS = false;
var YEAR = 2023;
var CROP_TRAINING_ASSET = 'users/YOUR_USERNAME/indus_crop_training_samples';
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
  return image.addBands([
    image.normalizedDifference(['B8', 'B4']).rename('NDVI'),
    image.expression('2.5*((NIR-RED)/(NIR+6*RED-7.5*BLUE+1))', {
      NIR: image.select('B8'),
      RED: image.select('B4'),
      BLUE: image.select('B2')
    }).rename('EVI'),
    image.normalizedDifference(['B3', 'B8']).rename('NDWI'),
    image.normalizedDifference(['B8', 'B11']).rename('LSWI')
  ]);
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
    .rename([prefix + '_NDVI', prefix + '_EVI', prefix + '_NDWI', prefix + '_LSWI']);
}

var predictors = composite(YEAR + '-05-01', YEAR + '-12-01', 'kharif')
  .addBands(composite((YEAR - 1) + '-11-01', YEAR + '-05-01', 'rabi'))
  .updateMask(croplandMask)
  .clip(studyArea);

var samples = ee.FeatureCollection(CROP_TRAINING_ASSET).filterBounds(studyArea);
var trainSamples = samples.filter(ee.Filter.eq('split', 'train'));
var validationSamples = samples.filter(ee.Filter.eq('split', 'validation'));

var training = predictors.sampleRegions({
  collection: trainSamples,
  properties: ['crop_code'],
  scale: EXPORT_SCALE,
  geometries: true,
  tileScale: 4
});

var classifier = ee.Classifier.smileRandomForest({
  numberOfTrees: 300,
  minLeafPopulation: 2,
  bagFraction: 0.7,
  seed: 20260709
}).train({
  features: training,
  classProperty: 'crop_code',
  inputProperties: predictors.bandNames()
});

var cropMap = predictors.classify(classifier).rename('crop_code').clip(studyArea).updateMask(croplandMask);
var validated = predictors.sampleRegions({
  collection: validationSamples,
  properties: ['crop_code'],
  scale: EXPORT_SCALE,
  geometries: true,
  tileScale: 4
}).classify(classifier);
var matrix = validated.errorMatrix('crop_code', 'classification');

print('Confusion matrix', matrix);
print('Overall accuracy', matrix.accuracy());
print('Kappa', matrix.kappa());

Map.centerObject(studyArea, 6);
Map.addLayer(cropMap, {
  min: 1,
  max: 5,
  palette: ['#d9b44a', '#5aae61', '#3288bd', '#d53e4f', '#abdda4']
}, 'Major crop classification');

if (RUN_EXPORTS) {
  Export.image.toDrive({
    image: cropMap,
    description: 'crop_classification_' + YEAR,
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'crop_classification_' + YEAR,
    region: studyArea,
    scale: EXPORT_SCALE,
    crs: ANALYSIS_CRS,
    maxPixels: 1e13
  });

  Export.table.toDrive({
    collection: ee.FeatureCollection([ee.Feature(null, {
      overall_accuracy: matrix.accuracy(),
      kappa: matrix.kappa(),
      confusion_matrix: matrix.array()
    })]),
    description: 'classification_accuracy_' + YEAR,
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'classification_accuracy_' + YEAR,
    fileFormat: 'CSV'
  });
}
