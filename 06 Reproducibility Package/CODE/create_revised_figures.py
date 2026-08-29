"""Create journal-specific revised figures from documented project outputs."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.patches import FancyArrowPatch, Rectangle
from PIL import Image


plt.rcParams.update({
    "font.family": "Times New Roman",
    "font.size": 10,
    "axes.titlesize": 12,
    "axes.labelsize": 10,
    "xtick.labelsize": 9,
    "ytick.labelsize": 9,
    "legend.fontsize": 9,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})


def save_figure(fig: plt.Figure, stem: Path, dpi: int = 1200) -> None:
    fig.savefig(stem.with_suffix(".png"), dpi=dpi, bbox_inches="tight", facecolor="white")
    fig.savefig(stem.with_suffix(".tif"), dpi=dpi, bbox_inches="tight", facecolor="white", pil_kwargs={"compression": "tiff_lzw"})
    fig.savefig(stem.with_suffix(".pdf"), bbox_inches="tight", facecolor="white")
    fig.savefig(stem.with_suffix(".svg"), bbox_inches="tight", facecolor="white")


def copy_main_figures(project: Path, output: Path) -> None:
    mapping = {
        "Figure_01_Study_Area_1200dpi.png": project / "05_Final_Maps/Map_01_Study_Area_Indus_Basin_Pakistan_1200dpi.png",
        "Figure_02_Research_Workflow_1200dpi.png": project / "11_Manuscript_Submission/Working/Figure_02_Research_Workflow_1200dpi.png",
        "Figure_03_Cropland_Mask_2023_1200dpi.png": project / "05_Final_Maps/Map_06_Cropland_Mask_2023_1200dpi.png",
        "Figure_04_Major_Crop_Classification_2023_1200dpi.png": project / "05_Final_Maps/Map_11_Crop_Classification_1200dpi.png",
        "Figure_05_Seasonal_AETI_2023_1200dpi.png": project / "05_Final_Maps/Map_18_Seasonal_Actual_ET_1200dpi.png",
        "Figure_06_Effective_Rainfall_2023_1200dpi.png": project / "05_Final_Maps/Map_25_Seasonal_Effective_Rainfall_1200dpi.png",
        "Figure_07_Green_Consumptive_Water_2023_1200dpi.png": project / "05_Final_Maps/Map_26_Green_Water_Use_1200dpi.png",
        "Figure_08_Residual_Blue_Consumptive_Water_2023_1200dpi.png": project / "05_Final_Maps/Map_27_Blue_Water_Use_1200dpi.png",
        "Figure_09_Green_Blue_Volumes_By_Crop_1200dpi.png": project / "06_Final_Graphs/Graph_01_Green_vs_Blue_Water_by_Crop_1200dpi.png",
        "Figure_10_Total_VWF_2023_1200dpi.png": project / "05_Final_Maps/Map_33_Total_Virtual_Water_Footprint_1200dpi.png",
        "Figure_11_Water_Productivity_2023_1200dpi.png": project / "05_Final_Maps/Map_34_Water_Productivity_1200dpi.png",
        "Figure_12_Crop_VWF_Comparison_1200dpi.png": project / "06_Final_Graphs/Graph_03_Virtual_Water_Footprint_by_Crop_1200dpi.png",
        "Figure_13_Blue_Dependency_2023_1200dpi.png": project / "05_Final_Maps/Map_30_Blue_Water_Dependency_1200dpi.png",
        "Figure_14_Relative_Diagnostic_Hotspots_2023_1200dpi.png": project / "05_Final_Maps/Map_39_Water_Use_Efficiency_Hotspots_1200dpi.png",
    }
    for name, source in mapping.items():
        if not source.exists():
            raise FileNotFoundError(source)
        shutil.copy2(source, output / name)


def endpoint_figure(table_path: Path, output: Path) -> None:
    table = pd.read_csv(table_path)
    table = table[table["metric"].eq("total_vwf_m3_t")].copy()
    order = ["Wheat", "Rice", "Cotton", "Sugarcane", "Maize"]
    table["crop_name"] = pd.Categorical(table["crop_name"], order, ordered=True)
    table = table.sort_values("crop_name")
    x = np.arange(len(table))
    primary = table["primary_wapor_chirps"].to_numpy()
    comparison = table["comparison_modis_era5_land"].to_numpy()

    fig, ax = plt.subplots(figsize=(7.2, 4.2), constrained_layout=True)
    for i, (a, b) in enumerate(zip(primary, comparison)):
        ax.plot([i, i], [min(a, b), max(a, b)], color="#666666", linewidth=1.4, zorder=1)
    ax.scatter(x - 0.04, primary, color="#1f5a92", marker="o", s=48, label="WaPOR-CHIRPS (primary)", zorder=3)
    ax.scatter(x + 0.04, comparison, color="#b44a3e", marker="D", s=42, label="MODIS-ERA5-Land (comparison)", zorder=3)
    ax.set_xticks(x, order)
    ax.set_ylabel(r"Total virtual water footprint (m$^3$ t$^{-1}$)")
    ax.set_title("Two-endpoint structural sensitivity of crop virtual water footprint")
    ax.grid(axis="y", color="#d9d9d9", linewidth=0.6)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(frameon=False, ncol=1, loc="upper left", bbox_to_anchor=(1.01, 1.0), borderaxespad=0)
    ax.text(
        0.01, 0.02,
        "Endpoints are alternative product chains, not confidence limits.",
        transform=ax.transAxes, fontsize=8.5, color="#444444",
    )
    save_figure(fig, output / "Figure_15_Product_Chain_Endpoint_Sensitivity_1200dpi")
    plt.close(fig)


def hotspot_supplement(table_path: Path, output: Path) -> None:
    table = pd.read_csv(table_path)
    fig, ax = plt.subplots(figsize=(7.2, 4.2), constrained_layout=True)
    colors = {"all computable districts": "#356f9f", "districts with mapped area >=25,000 ha": "#b56f22"}
    for scope, part in table.groupby("scope", sort=False):
        ax.plot(part["threshold_pair"], part["priority_score_ge_2_count"], marker="o", linewidth=1.8, color=colors[scope], label=scope)
    ax.set_xlabel("Upper/lower percentile pair")
    ax.set_ylabel("Districts with priority score $\geq$ 2")
    ax.set_title("Sensitivity of relative diagnostic priority to percentile thresholds")
    ax.grid(axis="y", color="#d9d9d9", linewidth=0.6)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(frameon=False, loc="upper right")
    ax.text(0.01, 0.02, "Internal percentile screens are not hydrological sustainability thresholds.", transform=ax.transAxes, fontsize=8.5, color="#444444")
    save_figure(fig, output / "Figure_S2_Hotspot_Threshold_Sensitivity_1200dpi")
    plt.close(fig)


def crop_for_panel(path: Path, crop: tuple[float, float, float, float] | None = None) -> Image.Image:
    image = Image.open(path).convert("RGB")
    if crop:
        left, top, right, bottom = crop
        w, h = image.size
        image = image.crop((int(left*w), int(top*h), int(right*w), int(bottom*h)))
    return image


def graphical_abstract(project: Path, output: Path) -> None:
    images = {
        "crop": crop_for_panel(project / "05_Final_Maps/Map_11_Crop_Classification_1200dpi.png", (0.08, 0.08, 0.78, 0.94)),
        "et": crop_for_panel(project / "05_Final_Maps/Map_18_Seasonal_Actual_ET_1200dpi.png", (0.05, 0.08, 0.88, 0.90)),
        "water": crop_for_panel(project / "06_Final_Graphs/Graph_01_Green_vs_Blue_Water_by_Crop_1200dpi.png", (0.04, 0.05, 0.98, 0.83)),
        "hotspot": crop_for_panel(project / "05_Final_Maps/Map_39_Water_Use_Efficiency_Hotspots_1200dpi.png", (0.08, 0.08, 0.80, 0.94)),
    }
    fig = plt.figure(figsize=(12.5, 5.0), facecolor="white")
    title_color = "#17365d"
    fig.text(0.5, 0.955, "Remote sensing-based crop-water accounting in Pakistan's Indus Basin", ha="center", va="top", fontsize=18, fontweight="bold", color=title_color)
    fig.text(0.5, 0.89, "Pakistan Indus drainage-basin cropland | 2023 crop extent | crop-specific seasons", ha="center", va="top", fontsize=10.5, color="#444444")
    lefts = [0.025, 0.275, 0.525, 0.775]
    headings = [
        "1  Crop mapping",
        "2  Seasonal water depth",
        "3  Green-blue accounting",
        "4  Diagnostic outputs",
    ]
    colors = ["#2f7f59", "#2c6da4", "#b47d19", "#a94442"]
    keys = ["crop", "et", "water", "hotspot"]
    texts = [
        "Sentinel-1/2 + Landsat 8/9\nSpatial-block validation\n17.80 million crop-hectares",
        "WaPOR v3 AETI + CHIRPS\nCrop-specific calendars\n80.01 km3 crop-season ET",
        "Green ET = min(ET, effective rain)\nBlue ET = non-negative residual\nWheat blue ET: 19.60 km3",
        "VWF, productivity and hotspots\nCotton VWF: 2076.2 m3 t-1\nField verification prioritized",
    ]
    for left, heading, color, key, body in zip(lefts, headings, colors, keys, texts):
        fig.patches.append(Rectangle((left, 0.17), 0.225, 0.66, transform=fig.transFigure, facecolor="#fafafa", edgecolor=color, linewidth=1.3, zorder=-10))
        fig.patches.append(Rectangle((left, 0.76), 0.225, 0.07, transform=fig.transFigure, facecolor=color, edgecolor=color, zorder=1))
        fig.text(left + 0.012, 0.797, heading, color="white", fontsize=12, fontweight="bold", va="center")
        ax = fig.add_axes([left + 0.012, 0.39, 0.201, 0.34])
        ax.set_zorder(2)
        ax.patch.set_alpha(0)
        ax.imshow(images[key])
        ax.axis("off")
        fig.text(left + 0.015, 0.345, body, fontsize=9.2, va="top", color="#222222", linespacing=1.25)
    for x in [0.255, 0.505, 0.755]:
        fig.patches.append(FancyArrowPatch((x, 0.50), (x + 0.014, 0.50), transform=fig.transFigure, arrowstyle="-|>", mutation_scale=12, linewidth=1.3, color="#555555"))
    fig.text(0.5, 0.105, "Residual blue ET is an operational consumptive-use estimate, not measured canal diversion, groundwater pumping or net depletion.", ha="center", va="center", fontsize=10.5, fontweight="bold", color="#6b3f18")
    fig.text(0.5, 0.055, "Use: crop-season benchmarking, district screening and observation targeting; allocation decisions require delivery, groundwater, salinity and field water-balance data.", ha="center", va="center", fontsize=9.5, color=title_color)
    stem = output / "Graphical_Abstract_Agricultural_Water_Management"
    fig.savefig(stem.with_suffix(".png"), dpi=480, facecolor="white")
    fig.savefig(stem.with_suffix(".tif"), dpi=480, facecolor="white", pil_kwargs={"compression": "tiff_lzw"})
    fig.savefig(stem.with_suffix(".pdf"), facecolor="white")
    plt.close(fig)


def main() -> None:
    project = Path(sys.argv[1])
    revised_tables = Path(sys.argv[2])
    output = Path(sys.argv[3])
    output.mkdir(parents=True, exist_ok=True)
    copy_main_figures(project, output)
    endpoint_figure(revised_tables / "Table_S5_Product_Chain_Structural_Envelope.csv", output)
    hotspot_supplement(revised_tables / "Table_S7_Hotspot_Threshold_Sensitivity.csv", output)
    graphical_abstract(project, output)
    print(f"Created revised figure package in {output}")


if __name__ == "__main__":
    main()
