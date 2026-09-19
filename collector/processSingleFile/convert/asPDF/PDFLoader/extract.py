"""Extract PDF text locally; stdout is a UTF-8 JSON protocol, never logging."""

import json
import sys

try:
    import pymupdf
except ImportError:
    sys.stderr.write("PyMuPDF is unavailable; install collector/requirements-pdf.txt.\n")
    sys.exit(78)


def extract(filename):
    # MuPDF resolves embedded font mappings that the previous PDF.js loader
    # omitted or misinterpreted. No OCR, rendering, network, or source writes.
    with pymupdf.open(filename) as document:
        if not document.is_pdf:
            raise ValueError("The input is not a PDF document.")
        if document.needs_pass:
            raise ValueError("Password-protected PDF: provide an unlocked copy.")
        info = document.metadata or {}
        pages = []
        for page in document:
            text = page.get_text("text").strip()
            if text:
                pages.append({"pageNumber": page.number + 1, "text": text})
        return {
            "version": "PyMuPDF " + pymupdf.VersionBind,
            "totalPages": len(document),
            "info": {
                "Creator": info.get("creator", ""),
                "Title": info.get("title", ""),
                "Author": info.get("author", ""),
            },
            "pages": pages,
        }


if __name__ == "__main__":
    try:
        result = extract(sys.argv[1])
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        sys.exit(1)
