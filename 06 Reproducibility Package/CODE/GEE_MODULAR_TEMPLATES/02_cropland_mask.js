// 02 - Cropland mask from ESA WorldCover

var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var RUN_EXPORTS = false;
var EXPORT_SCALE = 30;
var ANALYSIS_CRS = 'EPSG:32642';

var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0').filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');
var indusMainBas = ee.Number(ee.Feature(hydro5.filterBounds(ee.Geometry.Point([68.0, 24.5])).sort('UP_AREA', false).first()).get('MAIN_BAS'));
var studyArea = hydro5.filter(ee.Filter.eq('MAIN_BAS', indusMainBas)).geometry()
  .intersection(pakistan.geometry(), ee.ErrorMargin(1000));

var worldCover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
var croplandMask = worldCover.eq(40).selfMask().rename('cropland').clip(studyArea);

var croplandAreaHa = ee.Image.pixelArea().divide(10000).updateMask(croplandMask).rename('cropland_area_ha');
var totalCropland = croplandAreaHa.reduceRegion({
  reducer: ee.Reducer.sum(),
  geometry: studyArea,
  scale: 100,
  crs: ANALYSIS_CRS,
  maxPixels: 1e13
});

print('ESA WorldCover class 40 cropland area ha', totalCropland);
Map.centerObject(studyArea, 6);
Map.addLayer(croplandMask, {palette: ['#74a57f']}, 'Cropland mask: ESA WorldCover class 40');

if (RUN_EXPORTS) {
  Export.image.toDrive({
    image: croplandMask,
    description: 'cropland_mask_worldcover_indus_pakistan',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'cropland_mask_worldcover_indus_pakistan',
    region: studyArea,
    scale: EXPORT_SCALE,
    crs: ANALYSIS_CRS,
    maxPixels: 1e13
  });
}
