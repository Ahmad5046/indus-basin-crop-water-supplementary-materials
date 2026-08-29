"""Recheck the previously verified reference workbook against DOI/Crossref metadata."""

from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import pandas as pd


def normalize(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def main() -> None:
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    refs = pd.read_excel(source, sheet_name="Verified References")
    user_agent = "IndusManuscriptReferenceAudit/1.0 (scientific metadata verification)"
    records = []
    for row in refs.to_dict("records"):
        doi = str(row.get("DOI") or "").strip()
        url = str(row.get("URL") or "").strip()
        if doi.lower() == "nan":
            doi = ""
        doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi, flags=re.I)
        resolver_status = None
        resolver_url = ""
        crossref_status = None
        crossref_title = ""
        crossref_year = None
        title_similarity = None
        error = ""
        target = f"https://doi.org/{doi}" if doi else url
        if target:
            try:
                request = Request(target, headers={"User-Agent": user_agent})
                with urlopen(request, timeout=25) as response:
                    resolver_status = response.status
                    resolver_url = response.geturl()
            except HTTPError as exc:
                error = f"Resolver HTTPError: {exc.code} {exc.reason}"
            except Exception as exc:  # network evidence is recorded, never silently imputed
                error = f"Resolver {type(exc).__name__}: {exc}"
        if doi:
            try:
                request = Request(
                    f"https://api.crossref.org/works/{quote(doi, safe='')}",
                    headers={"User-Agent": user_agent},
                )
                with urlopen(request, timeout=25) as response:
                    crossref_status = response.status
                    message = json.loads(response.read().decode("utf-8")).get("message", {})
                    crossref_title = (message.get("title") or [""])[0]
                    date_parts = (
                        message.get("published-print", {}).get("date-parts")
                        or message.get("published-online", {}).get("date-parts")
                        or message.get("issued", {}).get("date-parts")
                        or [[None]]
                    )
                    crossref_year = date_parts[0][0]
                    title_similarity = SequenceMatcher(None, normalize(row.get("Title")), normalize(crossref_title)).ratio()
            except HTTPError as exc:
                suffix = f"Crossref HTTPError: {exc.code} {exc.reason}"
                error = f"{error}; {suffix}" if error else suffix
            except Exception as exc:
                suffix = f"Crossref {type(exc).__name__}: {exc}"
                error = f"{error}; {suffix}" if error else suffix
        records.append({
            "final_id": row.get("Final ID"),
            "authors": row.get("Authors"),
            "manuscript_year": row.get("Year"),
            "manuscript_title": row.get("Title"),
            "doi": doi,
            "authoritative_url": url,
            "resolver_http_status": resolver_status,
            "resolver_final_url": resolver_url,
            "crossref_http_status": crossref_status,
            "crossref_title": crossref_title,
            "crossref_year": crossref_year,
            "title_similarity_0_1": title_similarity,
            "prior_verification_status": row.get("Verification Status"),
            "audit_error": error,
        })
        time.sleep(0.05)
    result = pd.DataFrame(records)
    result.to_csv(output, index=False)
    resolver_ok = result["resolver_http_status"].between(200, 399).sum()
    doi_rows = result["doi"].astype(bool).sum()
    crossref_ok = result["crossref_http_status"].eq(200).sum()
    low_similarity = result[
        result["crossref_http_status"].eq(200)
        & result["title_similarity_0_1"].notna()
        & result["title_similarity_0_1"].lt(0.80)
    ]
    summary = {
        "reference_rows": len(result),
        "doi_rows": int(doi_rows),
        "resolver_success_rows": int(resolver_ok),
        "crossref_metadata_success_rows": int(crossref_ok),
        "crossref_low_title_similarity_rows": int(len(low_similarity)),
        "crossref_low_title_similarity_ids": low_similarity["final_id"].tolist(),
        "network_error_rows": int(result["audit_error"].astype(bool).sum()),
        "interpretation": "Crossref absence is not failure for DataCite or authoritative institutional records; DOI resolution and prior row-level verification remain separate evidence.",
    }
    Path(str(output) + ".summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
