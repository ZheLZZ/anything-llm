const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const JWT = require("jsonwebtoken");
const { v4: uuidv4, validate: uuidValidate } = require("uuid");

const ORIGINAL_DOCUMENT_DOWNLOAD_PURPOSE = "original-document-download";

const originalDocumentsPath =
  process.env.NODE_ENV === "development"
    ? path.resolve(__dirname, "../../storage/original-documents")
    : path.resolve(
        process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage"),
        "original-documents"
      );

function isStrictlyWithin(outer, inner) {
  const relative = path.relative(path.resolve(outer), path.resolve(inner));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function ensureStorageDirectory(basePath = originalDocumentsPath) {
  await fs.promises.mkdir(basePath, { recursive: true });
  return basePath;
}

function resolveStoragePath(storageKey, basePath = originalDocumentsPath) {
  if (typeof storageKey !== "string" || !uuidValidate(storageKey))
    throw new Error("Invalid original document storage key.");

  const target = path.resolve(basePath, storageKey);
  if (!isStrictlyWithin(basePath, target))
    throw new Error("Invalid original document storage key.");
  return target;
}

/**
 * Copies a Multer-staged upload into persistent storage before Collector can
 * remove the hotdir copy. The opaque UUID is deliberately unrelated to the
 * user-controlled filename and has no extension-based addressing semantics.
 */
async function preserveUploadedFile({
  sourcePath,
  originalFilename,
  originalRelativePath = null,
  mimeType = null,
  sizeBytes = null,
  basePath = originalDocumentsPath,
}) {
  if (!sourcePath) throw new Error("No staged upload was provided.");
  const sourceStat = await fs.promises.lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
    throw new Error("The staged upload is not a regular file.");

  await ensureStorageDirectory(basePath);
  for (let attempt = 0; attempt < 3; attempt++) {
    const originalStorageKey = uuidv4();
    const destination = resolveStoragePath(originalStorageKey, basePath);
    try {
      await fs.promises.copyFile(
        sourcePath,
        destination,
        fs.constants.COPYFILE_EXCL
      );
      return {
        originalStorageKey,
        originalFilename: sanitizeDownloadFilename(originalFilename),
        originalRelativePath: cleanRelativePath(originalRelativePath),
        originalMimeType: normalizeMimeType(mimeType),
        originalSizeBytes: String(sizeBytes ?? sourceStat.size),
        originalUploadedAt: new Date(),
      };
    } catch (error) {
      if (error.code === "EEXIST" && attempt < 2) continue;
      if (error.code !== "EEXIST") {
        try {
          await fs.promises.unlink(destination);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT")
            console.error(
              `Failed to clean a partial original upload (${cleanupError.code || "UNKNOWN"}).`
            );
        }
      }
      throw error;
    }
  }

  throw new Error("Unable to allocate original document storage.");
}

async function storedOriginalFile(
  storageKey,
  basePath = originalDocumentsPath
) {
  await ensureStorageDirectory(basePath);
  const target = resolveStoragePath(storageKey, basePath);

  let stat;
  try {
    stat = await fs.promises.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;

  const [realBase, realTarget] = await Promise.all([
    fs.promises.realpath(basePath),
    fs.promises.realpath(target),
  ]);
  if (!isStrictlyWithin(realBase, realTarget)) return null;
  return { path: realTarget, stat };
}

async function originalExists(storageKey, basePath = originalDocumentsPath) {
  if (!storageKey) return false;
  try {
    return !!(await storedOriginalFile(storageKey, basePath));
  } catch {
    return false;
  }
}

/** Streams through Express' sendFile implementation, retaining Range support. */
async function streamOriginalFile({
  response,
  storageKey,
  downloadFilename,
  mimeType,
  basePath = originalDocumentsPath,
}) {
  const stored = await storedOriginalFile(storageKey, basePath);
  if (!stored) return false;

  response.set({
    "Cache-Control": "private, no-store",
    "Content-Type": normalizeMimeType(mimeType),
    "Content-Length": String(stored.stat.size),
    "Accept-Ranges": "bytes",
  });

  await new Promise((resolve, reject) => {
    response.download(
      stored.path,
      sanitizeDownloadFilename(downloadFilename),
      { acceptRanges: true, cacheControl: false },
      (error) => (error ? reject(error) : resolve())
    );
  });
  return true;
}

async function removeOriginalFile(
  storageKey,
  basePath = originalDocumentsPath
) {
  if (!storageKey) return true;
  const target = resolveStoragePath(storageKey, basePath);
  try {
    const stat = await fs.promises.lstat(target);
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;
    await fs.promises.unlink(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function cleanupStagedOriginal(
  storageKey,
  basePath = originalDocumentsPath
) {
  return removeOriginalFile(storageKey, basePath);
}

function sanitizeDownloadFilename(filename) {
  const basename = stripControlCharacters(String(filename || "document"))
    .split(/[\\/]/)
    .pop()
    .trim();
  return Array.from(basename || "document")
    .slice(0, 255)
    .join("");
}

function cleanRelativePath(relativePath) {
  if (typeof relativePath !== "string") return null;
  const cleaned = stripControlCharacters(relativePath)
    .replace(/\\/g, "/")
    .trim();
  const segments = cleaned.split("/");
  if (
    !cleaned ||
    path.posix.isAbsolute(cleaned) ||
    /^[a-z]:\//i.test(cleaned) ||
    cleaned.startsWith("//") ||
    segments.some((segment) => segment === "." || segment === "..")
  )
    return null;
  return cleaned;
}

function stripControlCharacters(value) {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0);
      return code > 31 && !(code >= 127 && code <= 159);
    })
    .join("");
}

function normalizeMimeType(mimeType) {
  const value = String(mimeType || "")
    .trim()
    .toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)
    ? value
    : "application/octet-stream";
}

function originalDocumentDownloadTokenSecret() {
  const signingKey = process.env.SIG_KEY || process.env.JWT_SECRET;
  if (!signingKey) {
    const error = new Error(
      "No server signing key is available for original document downloads."
    );
    error.code = "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE";
    throw error;
  }

  return crypto
    .createHmac("sha256", String(signingKey))
    .update(
      "anythingllm:" +
        ORIGINAL_DOCUMENT_DOWNLOAD_PURPOSE +
        ":v1:" +
        (process.env.SIG_SALT || "")
    )
    .digest();
}

function createOriginalDocumentDownloadToken(
  libraryDocumentId,
  expiresIn = "60s"
) {
  if (!libraryDocumentId) {
    const error = new Error("A library document ID is required.");
    error.code = "INVALID_LIBRARY_DOCUMENT_ID";
    throw error;
  }

  return JWT.sign(
    {
      purpose: ORIGINAL_DOCUMENT_DOWNLOAD_PURPOSE,
      libraryDocumentId: String(libraryDocumentId),
    },
    originalDocumentDownloadTokenSecret(),
    { expiresIn }
  );
}

function verifyOriginalDocumentDownloadToken(token) {
  if (typeof token !== "string" || !token) return null;
  try {
    return JWT.verify(token, originalDocumentDownloadTokenSecret());
  } catch {
    return null;
  }
}

module.exports = {
  ORIGINAL_DOCUMENT_DOWNLOAD_PURPOSE,
  originalDocumentsPath,
  ensureStorageDirectory,
  preserveUploadedFile,
  resolveStoragePath,
  streamOriginalFile,
  removeOriginalFile,
  originalExists,
  cleanupStagedOriginal,
  sanitizeDownloadFilename,
  normalizeMimeType,
  createOriginalDocumentDownloadToken,
  verifyOriginalDocumentDownloadToken,
};
