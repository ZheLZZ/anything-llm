const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const PDFLoader = require("../processSingleFile/convert/asPDF/PDFLoader");

const python =
  process.env.PDF_PYTHON_PATH ||
  (process.platform === "win32" ? "python" : "python3");
let directory;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-loader-test-"));
  execFileSync(
    python,
    ["-I", "-X", "utf8", path.join(__dirname, "pdf_fixtures.py"), directory],
    { windowsHide: true }
  );
});
after(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test("CJK without ToUnicode, mixed English, page gaps, metadata and source preservation", async () => {
  const filename = path.join(directory, "中文 test.pdf");
  const before = await fs.readFile(filename);
  const pages = await new PDFLoader(filename).load();
  assert.deepEqual(
    pages.map((p) => p.metadata.loc.pageNumber),
    [1, 3]
  );
  assert.match(pages[0].pageContent, /证券及期货事务监察委员会 海螺 用户 视频/);
  assert.match(pages[0].pageContent, /English revenue 2024: 30,523/);
  assert.match(pages[1].pageContent, /證券及期貨事務監察委員會/);
  assert.equal(pages[0].metadata.pdf.totalPages, 3);
  assert.equal(pages[0].metadata.pdf.info.Creator, "Synthetic PDF test");
  assert.deepEqual(await fs.readFile(filename), before);
});

test("combined output separates pages", async () => {
  const filename = path.join(directory, "中文 test.pdf");
  const pages = await new PDFLoader(filename).load();
  const combined = await new PDFLoader(filename, { splitPages: false }).load();
  assert.equal(combined.length, 1);
  assert.equal(
    combined[0].pageContent,
    pages.map((p) => p.pageContent).join("\n\n")
  );
  assert.equal(combined[0].metadata.pdf.totalPages, 3);
});

test("image-only PDF returns no text to preserve OCR dispatch", async () => {
  assert.deepEqual(
    await new PDFLoader(path.join(directory, "image-only.pdf")).load(),
    []
  );
});

test("locked or invalid PDFs fail instead of returning misleading text", async () => {
  await assert.rejects(
    new PDFLoader(path.join(directory, "locked.pdf")).load(),
    /Password-protected PDF/
  );
  await assert.rejects(
    new PDFLoader(path.join(directory, "invalid.pdf")).load(),
    /PDF text extraction failed/
  );
});

test("missing Python gives an actionable error with no legacy fallback", async () => {
  await assert.rejects(
    new PDFLoader(path.join(directory, "中文 test.pdf"), {
      pythonPath: path.join(directory, "nonexistent-python"),
    }).load(),
    /requirements-pdf.txt.*PDF_PYTHON_PATH/
  );
});

test("upload conversion preserves page boundaries and reports extraction failures", async () => {
  process.env.NODE_ENV = "production";
  process.env.STORAGE_DIR = directory;
  const asPdf = require("../processSingleFile/convert/asPDF");
  const filename = path.join(directory, "中文 test.pdf");
  const pages = await new PDFLoader(filename).load();
  const converted = await asPdf({
    fullFilePath: filename,
    filename: "synthetic.pdf",
    options: { absolutePath: filename },
  });
  assert.equal(converted.success, true);
  assert.equal(
    converted.documents[0].pageContent,
    pages.map((p) => p.pageContent).join("\n\n")
  );
  assert.equal(converted.documents[0].docAuthor, "Synthetic PDF test");
  const failed = await asPdf({
    fullFilePath: path.join(directory, "locked.pdf"),
    filename: "locked.pdf",
    options: { absolutePath: path.join(directory, "locked.pdf") },
  });
  assert.equal(failed.success, false);
  assert.match(failed.reason, /Password-protected PDF/);
  assert.deepEqual(failed.documents, []);
});

test("image-only upload still dispatches to the existing OCR loader", async () => {
  process.env.NODE_ENV = "production";
  process.env.STORAGE_DIR = directory;
  const OCRLoader = require("../utils/OCRLoader");
  const original = OCRLoader.prototype.ocrPDF;
  let called = false;
  OCRLoader.prototype.ocrPDF = async function (filename) {
    assert.equal(filename, path.join(directory, "image-only.pdf"));
    called = true;
    return [
      {
        pageContent: "Synthetic OCR result",
        metadata: { loc: { pageNumber: 1 } },
      },
    ];
  };
  try {
    const asPdf = require("../processSingleFile/convert/asPDF");
    const filename = path.join(directory, "image-only.pdf");
    const result = await asPdf({
      fullFilePath: filename,
      filename: "image-only.pdf",
      options: { absolutePath: filename },
    });
    assert.equal(called, true);
    assert.equal(result.success, true);
    assert.equal(result.documents[0].pageContent, "Synthetic OCR result");
  } finally {
    OCRLoader.prototype.ocrPDF = original;
  }
});
