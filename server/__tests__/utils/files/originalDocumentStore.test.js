process.env.STORAGE_DIR = __dirname;

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const {
  preserveUploadedFile,
  resolveStoragePath,
  originalExists,
  removeOriginalFile,
  sanitizeDownloadFilename,
  streamOriginalFile,
  createOriginalDocumentDownloadToken,
  verifyOriginalDocumentDownloadToken,
} = require("../../../utils/files/originalDocumentStore");

describe("originalDocumentStore", () => {
  let root;
  let uploads;
  let originals;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "original-store-test-"));
    uploads = path.join(root, "uploads");
    originals = path.join(root, "originals");
    fs.mkdirSync(uploads, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("retains byte-identical uploads under unrelated opaque keys", async () => {
    const first = path.join(uploads, "one.bin");
    const second = path.join(uploads, "two.bin");
    const content = Buffer.from([0, 1, 2, 3, 254, 255]);
    fs.writeFileSync(first, content);
    fs.writeFileSync(second, content);

    const savedOne = await preserveUploadedFile({
      sourcePath: first,
      originalFilename: "同名文件.pdf",
      mimeType: "application/pdf",
      basePath: originals,
    });
    const savedTwo = await preserveUploadedFile({
      sourcePath: second,
      originalFilename: "同名文件.pdf",
      mimeType: "application/pdf",
      basePath: originals,
    });

    expect(savedOne.originalStorageKey).not.toBe(savedTwo.originalStorageKey);
    expect(savedOne.originalStorageKey).not.toContain("同名文件");
    expect(
      fs.readFileSync(
        resolveStoragePath(savedOne.originalStorageKey, originals)
      )
    ).toEqual(content);
    expect(
      fs.readFileSync(
        resolveStoragePath(savedTwo.originalStorageKey, originals)
      )
    ).toEqual(content);
  });

  it("removes a partial destination when a storage copy fails", async () => {
    const upload = path.join(uploads, "partial.bin");
    fs.writeFileSync(upload, "complete source");
    const copyFile = jest
      .spyOn(fs.promises, "copyFile")
      .mockImplementation(async (_source, destination) => {
        fs.writeFileSync(destination, "partial destination");
        throw Object.assign(new Error("disk failure"), { code: "EIO" });
      });

    await expect(
      preserveUploadedFile({
        sourcePath: upload,
        originalFilename: "partial.bin",
        basePath: originals,
      })
    ).rejects.toThrow("disk failure");
    expect(fs.readdirSync(originals)).toEqual([]);
    copyFile.mockRestore();
  });

  it.each([
    "../../etc/passwd",
    "C:\\Windows\\system.ini",
    "\\\\server\\share\\secret",
    "%2e%2e%2fsecret",
    "not-a-storage-key",
  ])("rejects forged storage key %s", (storageKey) => {
    expect(() => resolveStoragePath(storageKey, originals)).toThrow(
      /storage key/
    );
  });

  it("creates and verifies download tokens without JWT_SECRET", () => {
    const priorJwtSecret = process.env.JWT_SECRET;
    const priorSigKey = process.env.SIG_KEY;
    const priorSigSalt = process.env.SIG_SALT;
    delete process.env.JWT_SECRET;
    process.env.SIG_KEY = "original-download-test-signing-key";
    process.env.SIG_SALT = "original-download-test-signing-salt";

    try {
      const token = createOriginalDocumentDownloadToken("library-1");
      expect(verifyOriginalDocumentDownloadToken(token)).toMatchObject({
        purpose: "original-document-download",
        libraryDocumentId: "library-1",
      });
      expect(
        verifyOriginalDocumentDownloadToken(
          createOriginalDocumentDownloadToken("library-2")
        ).libraryDocumentId
      ).toBe("library-2");
      expect(
        verifyOriginalDocumentDownloadToken(token + "tampered")
      ).toBeNull();
      expect(
        verifyOriginalDocumentDownloadToken(
          createOriginalDocumentDownloadToken("library-1", "-1s")
        )
      ).toBeNull();
    } finally {
      if (priorJwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = priorJwtSecret;
      if (priorSigKey === undefined) delete process.env.SIG_KEY;
      else process.env.SIG_KEY = priorSigKey;
      if (priorSigSalt === undefined) delete process.env.SIG_SALT;
      else process.env.SIG_SALT = priorSigSalt;
    }
  });

  it("rejects a symlink even when its name is a valid storage key", async () => {
    fs.mkdirSync(originals, { recursive: true });
    const outside = path.join(root, "outside.bin");
    const key = uuidv4();
    fs.writeFileSync(outside, "secret");
    try {
      fs.symlinkSync(outside, path.join(originals, key), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) return;
      throw error;
    }
    expect(await originalExists(key, originals)).toBe(false);
  });

  it("sanitizes response-header control characters and path segments", () => {
    expect(sanitizeDownloadFilename("../../报告\r\nInjected: yes.pdf")).toBe(
      "报告Injected: yes.pdf"
    );
  });

  it.each(["../report.pdf", "folder/..", "C:\\secret\\report.pdf", "\\\\host\\share\\report.pdf"])(
    "does not retain an unsafe original relative path %s",
    async (originalRelativePath) => {
      const upload = path.join(uploads, "relative-path.bin");
      fs.writeFileSync(upload, "safe bytes");
      const saved = await preserveUploadedFile({
        sourcePath: upload,
        originalFilename: "report.pdf",
        originalRelativePath,
        basePath: originals,
      });
      expect(saved.originalRelativePath).toBeNull();
    }
  );

  it("removes only the requested opaque file", async () => {
    const upload = path.join(uploads, "file.txt");
    fs.writeFileSync(upload, "hello");
    const saved = await preserveUploadedFile({
      sourcePath: upload,
      originalFilename: "file.txt",
      basePath: originals,
    });

    expect(await originalExists(saved.originalStorageKey, originals)).toBe(true);
    await removeOriginalFile(saved.originalStorageKey, originals);
    expect(await originalExists(saved.originalStorageKey, originals)).toBe(false);
  });

  it("streams the retained bytes with a sanitized Chinese download name", async () => {
    const upload = path.join(uploads, "flattened-upload-name");
    const content = Buffer.from("byte-identical-original\u0000\u0001", "utf8");
    fs.writeFileSync(upload, content);
    const saved = await preserveUploadedFile({
      sourcePath: upload,
      originalFilename: "沐曦股份招股说明书.pdf",
      mimeType: "application/pdf",
      basePath: originals,
    });
    const response = {
      set: jest.fn(),
      download: jest.fn((filePath, filename, options, callback) => {
        expect(filename).toBe("沐曦股份招股说明书.pdf");
        expect(options).toEqual({ acceptRanges: true, cacheControl: false });
        expect(fs.readFileSync(filePath)).toEqual(content);
        callback();
      }),
    };

    await expect(
      streamOriginalFile({
        response,
        storageKey: saved.originalStorageKey,
        downloadFilename: saved.originalFilename,
        mimeType: saved.originalMimeType,
        basePath: originals,
      })
    ).resolves.toBe(true);
    expect(response.set).toHaveBeenCalledWith(
      expect.objectContaining({
        "Content-Type": "application/pdf",
        "Content-Length": String(content.length),
        "Accept-Ranges": "bytes",
      })
    );
  });

  it("serves byte ranges as an attachment without buffering the file", async () => {
    const upload = path.join(uploads, "range.bin");
    const content = Buffer.from("0123456789", "utf8");
    fs.writeFileSync(upload, content);
    const saved = await preserveUploadedFile({
      sourcePath: upload,
      originalFilename: "范围测试.bin",
      mimeType: "application/octet-stream",
      basePath: originals,
    });
    const app = express();
    app.get("/original", async (_request, response, next) => {
      try {
        await streamOriginalFile({
          response,
          storageKey: saved.originalStorageKey,
          downloadFilename: saved.originalFilename,
          mimeType: saved.originalMimeType,
          basePath: originals,
        });
      } catch (error) {
        next(error);
      }
    });
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });

    try {
      const result = await new Promise((resolve, reject) => {
        const request = http.get(
          {
            hostname: "127.0.0.1",
            port: server.address().port,
            path: "/original",
            headers: { Range: "bytes=2-5" },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                statusCode: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
              })
            );
          }
        );
        request.on("error", reject);
      });
      expect(result.statusCode).toBe(206);
      expect(result.headers["content-range"]).toBe("bytes 2-5/10");
      expect(result.headers["accept-ranges"]).toBe("bytes");
      expect(result.headers["content-disposition"]).toContain("attachment");
      expect(result.body).toEqual(content.subarray(2, 6));
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
