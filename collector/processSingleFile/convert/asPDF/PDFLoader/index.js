const { execFile } = require("child_process");
const path = require("path");
const { promisify } = require("util");

const runFile = promisify(execFile);

class PDFLoader {
  constructor(
    filePath,
    {
      splitPages = true,
      pythonPath = process.env.PDF_PYTHON_PATH ||
        (process.platform === "win32" ? "python" : "python3"),
    } = {}
  ) {
    this.filePath = filePath;
    this.splitPages = splitPages;
    this.pythonPath = pythonPath;
  }

  async load() {
    let stdout;
    try {
      ({ stdout } = await runFile(
        this.pythonPath,
        ["-I", "-X", "utf8", path.join(__dirname, "extract.py"), this.filePath],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 300_000,
          maxBuffer: 64 * 1024 * 1024,
        }
      ));
    } catch (error) {
      // Never silently fall back to pdf-parse: missing font mappings can
      // produce plausible-looking but incorrect CJK characters.
      if (error.code === "ENOENT" || error.code === 78) {
        throw new Error(
          "PDF text extraction requires Python with PyMuPDF. Install collector/requirements-pdf.txt and set PDF_PYTHON_PATH to that Python executable."
        );
      }
      const detail =
        error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "extracted text exceeds the 64 MiB output limit"
          : error.killed
          ? "extraction timed out"
          : error.stderr?.trim().slice(-2000) || error.message;
      throw new Error(`PDF text extraction failed: ${detail}`);
    }

    const result = JSON.parse(stdout);
    const metadata = {
      source: this.filePath,
      pdf: {
        version: result.version,
        info: result.info,
        metadata: null,
        totalPages: result.totalPages,
      },
    };
    const documents = result.pages.map(({ pageNumber, text }) => ({
      pageContent: text,
      metadata: { ...metadata, loc: { pageNumber } },
    }));

    if (this.splitPages || documents.length === 0) return documents;
    return [
      {
        pageContent: documents.map((doc) => doc.pageContent).join("\n\n"),
        metadata,
      },
    ];
  }
}

module.exports = PDFLoader;
