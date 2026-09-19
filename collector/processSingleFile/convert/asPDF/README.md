# PDF text extraction

PDF uploads use a local PyMuPDF subprocess. The previous pdf-parse / PDF.js
1.10.100 loader silently lost CJK text without built-in CMaps and could still
misdecode modified embedded fonts after supplying those maps. A successful
text extraction was therefore not evidence that the text was correct.

Docker installs the pinned `collector/requirements-pdf.txt` into
`/app/pdf-venv` at image build time. Uploads never install packages or send PDFs
to an external parser. Rebuild the image when changing the requirement.

For development, install Python 3.10+ and run, from the repository root:

```sh
python -m venv .pdf-venv
# Linux / macOS:
.pdf-venv/bin/python -m pip install -r collector/requirements-pdf.txt
# Windows:
.pdf-venv/Scripts/python.exe -m pip install -r collector/requirements-pdf.txt
```

Set `PDF_PYTHON_PATH` to that virtual environment's absolute Python executable
path in the collector environment. Without it, the loader uses `python` on
Windows and `python3` elsewhere. The executable is launched directly, without
a shell, with UTF-8 and isolated Python imports.

Missing dependencies, locked or damaged PDFs, timeouts (5 minutes) and output
over 64 MiB fail the upload rather than falling back to corrupted PDF.js text.
Empty text still invokes the existing scanned-document OCR path. Mixed
image/text-page OCR and complex table reconstruction are outside this fix.
Physical page numbers remain in loader metadata; the existing document writer
still produces one combined document, now with blank lines between pages.
No settings, existing documents or vectors are rewritten by this change.

Run regression tests from the repository root after installing the dependency:

```sh
node --test collector/__tests__/PDFLoader.test.js
```

Tests create synthetic PDFs in a temporary directory; they include CJK fonts
without a ToUnicode map, an image-only PDF, page gaps, encryption and invalid
input. Customer documents are not committed as fixtures.

PyMuPDF is an external dependency distributed under AGPL-3.0 or a commercial
license; see https://github.com/pymupdf/PyMuPDF for its license and notices.
