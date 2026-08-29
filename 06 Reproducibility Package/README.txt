REPRODUCIBILITY PACKAGE

Purpose
This package contains the code, authoritative derived tables, QC outputs, and metadata used in the comprehensive manuscript revision. It does not redistribute all third-party rasters or restricted provider data.

Analytical scope
- Cropland within the Pakistan portion of the Indus drainage basin.
- 2023 crop-season extent; crop-hectares are not unique physical hectares.
- Residual blue ET is ET not covered by modeled effective rainfall under the adopted rainfall-first convention. It is not measured irrigation withdrawal, groundwater abstraction, or net depletion.

Main folders
- CODE: reported-run and revision scripts; modular GEE templates.
- DATA/CLASSIFICATION: archived confusion matrices, metrics, feature importance, and sample QC.
- DATA/WATER_VWF: crop, district-crop, and province water/footprint outputs.
- DATA/TRENDS: fixed-2023-extent 2018-2023 context.
- DATA/REVISION_AUDIT: supplementary diagnostics and numerical QC.
- METADATA: environment, reference verification, package inventory.
- DOCUMENTATION: seed provenance and source limitations.

Recommended execution order
1. Inspect DATA and METADATA before rerunning cloud processing.
2. Use CODE/prepare_adb_ground_truth.py for deterministic spatial block allocation.
3. Use CODE/run_complete_gee_crop_classification_REPORTED_RUN.py for the classifier seed recorded in the archived metrics.
4. Run CODE/run_scientific_audit.py from the complete project root to regenerate revision tables.
5. Run CODE/create_revised_figures.py and CODE/revise_manuscript.py only after verifying project paths.

Availability limitation
This is a local revision archive. A public DOI/URL has not been verified and must not be claimed until deposition is complete.
