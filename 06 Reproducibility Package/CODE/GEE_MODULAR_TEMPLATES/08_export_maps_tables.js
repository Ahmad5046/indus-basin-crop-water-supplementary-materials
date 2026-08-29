// 08 - Batch export checklist
// Recommended: use 00_MASTER_WORKFLOW.js for actual batch exports.

// Export order:
// 1. Boundary and district table.
// 2. Cropland mask.
// 3. Seasonal Sentinel-2 index composites.
// 4. Crop classification map and accuracy table if validated training data exist.
// 5. AETI, rainfall, effective rainfall, green water, blue water, and total crop water use.
// 6. District crop/cropland water-use table.
// 7. Post-process VWF using official crop statistics in Python.

print('Open 00_MASTER_WORKFLOW.js, set RUN_EXPORTS = true, inspect layers, then run exports from the Tasks tab.');
