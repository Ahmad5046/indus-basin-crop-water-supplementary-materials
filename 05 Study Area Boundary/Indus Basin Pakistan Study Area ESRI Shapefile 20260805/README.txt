INDUS BASIN PAKISTAN STUDY-AREA SHAPEFILES

Study-area definition:
Pakistan portion of HydroBASINS level-5 main basin ID 4050033640, intersected
with the Pakistan national boundary used by the project.

Files:
1. indus_basin_pakistan_study_area_wgs84.shp
   CRS: EPSG:4326 (WGS 84). Recommended for Google Earth Engine upload.

2. indus_basin_pakistan_study_area_utm42n.shp
   CRS: EPSG:32642 (WGS 84 / UTM zone 42N). Recommended for metric area and
   distance calculations within the project.

Geometry processing:
The source GeoPackage contains a valid GeometryCollection composed of four
polygon components and one zero-area LineString boundary artifact. ESRI
Shapefile cannot store mixed geometry types in one layer. The shapefiles retain
and dissolve all polygon components into one valid MultiPolygon; only the
zero-area line artifact is excluded.

Important interpretation:
This drainage-basin analysis boundary is not an official Indus Basin Irrigation
System canal-command boundary. It may include rainfed or partly irrigated
cropland. Do not use it to attribute canal-command performance.

Source geometry retained unchanged at:
../indus_basin_pakistan_study_area.gpkg
../indus_basin_pakistan_study_area.geojson

Created: 2026-08-05
