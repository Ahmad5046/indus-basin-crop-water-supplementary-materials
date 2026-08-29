// 01 - Indus Basin boundary preparation
// Use in Google Earth Engine Code Editor opened with Microsoft Edge.

var EXPORT_FOLDER = 'GEE_Indus_GreenBlueVWF';
var RUN_EXPORTS = false;

var pakistan = ee.FeatureCollection('FAO/GAUL/2015/level0')
  .filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var provinces = ee.FeatureCollection('FAO/GAUL/2015/level1')
  .filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var districts = ee.FeatureCollection('FAO/GAUL/2015/level2')
  .filter(ee.Filter.eq('ADM0_NAME', 'Pakistan'));
var hydro5 = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_5');

// Outlet point selected on the lower Indus channel near the delta.
var indusOutlet = ee.Geometry.Point([68.0, 24.5]);
var outletBasin = ee.Feature(hydro5.filterBounds(indusOutlet).sort('UP_AREA', false).first());
var indusMainBas = ee.Number(outletBasin.get('MAIN_BAS'));
var indusBasin = hydro5.filter(ee.Filter.eq('MAIN_BAS', indusMainBas));
var studyArea = indusBasin.geometry().intersection(pakistan.geometry(), ee.ErrorMargin(1000));
var studyDistricts = districts.filterBounds(studyArea);
var studyProvinces = provinces.filterBounds(studyArea);

print('HydroBASINS MAIN_BAS used for Indus', indusMainBas);
print('Study area km2', studyArea.area(1000).divide(1e6));
print('Province count', studyProvinces.size());
print('District count', studyDistricts.size());

Map.centerObject(studyArea, 6);
Map.addLayer(indusBasin, {color: '4d4d4d'}, 'Full HydroBASINS Indus basin', false);
Map.addLayer(studyArea, {color: '000000'}, 'Indus Basin within Pakistan', true);
Map.addLayer(studyDistricts.style({color: '808080', fillColor: '00000000', width: 1}), {}, 'Study districts', false);

if (RUN_EXPORTS) {
  Export.table.toDrive({
    collection: ee.FeatureCollection([ee.Feature(studyArea, {
      ADM0_NAME: 'Pakistan',
      basin: 'Indus',
      MAIN_BAS: indusMainBas
    })]),
    description: 'indus_basin_pakistan_boundary',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'indus_basin_pakistan_boundary',
    fileFormat: 'GeoJSON'
  });

  Export.table.toDrive({
    collection: studyDistricts,
    description: 'indus_basin_pakistan_districts',
    folder: EXPORT_FOLDER,
    fileNamePrefix: 'indus_basin_pakistan_districts',
    fileFormat: 'CSV'
  });
}
