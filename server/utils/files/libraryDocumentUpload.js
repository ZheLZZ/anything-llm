const fs = require("fs");
const path = require("path");
const { LibraryDocuments } = require("../../models/libraryDocuments");
const {
  preserveUploadedFile,
  cleanupStagedOriginal,
} = require("./originalDocumentStore");
const {
  hotdirPath,
  isWithin,
  purgeSourceDocument,
  moveProcessedDocsToFolder,
} = require(".");

async function stageOriginalUpload(file, body = {}) {
  if (!file?.path) throw new Error("Uploaded file metadata is missing.");
  return preserveUploadedFile({
    sourcePath: file.path,
    originalFilename: body.originalFilename || file.originalname,
    originalRelativePath:
      body.originalRelativePath || body.relativePath || null,
    mimeType: file.mimetype,
    sizeBytes: file.size,
  });
}

async function registerUploadedDocuments(
  documents,
  original,
  sourceType = "upload"
) {
  const records = await LibraryDocuments.registerParsedDocuments(documents, {
    sourceType,
    original,
  });
  assertCompleteRegistration(documents, records);
  return LibraryDocuments.enrichPublicDocuments(documents, {
    docpaths: documents.map((document) => document.location),
    ensureLegacy: false,
  });
}

async function registerSourceDocuments(documents, sourceType) {
  const records = await LibraryDocuments.registerParsedDocuments(documents, {
    sourceType,
  });
  assertCompleteRegistration(documents, records);
  return LibraryDocuments.enrichPublicDocuments(documents, {
    docpaths: documents.map((document) => document.location),
    ensureLegacy: false,
  });
}

function assertCompleteRegistration(documents = [], records = []) {
  const expectedDocpaths = new Set(
    documents
      .map((document) => LibraryDocuments.canonicalDocpath(document?.location))
      .filter(Boolean)
  );
  if (
    expectedDocpaths.size === 0 ||
    expectedDocpaths.size !== documents.length ||
    records.length !== expectedDocpaths.size
  ) {
    const error = new Error("Processed document registration was incomplete.");
    error.code = "LIBRARY_REGISTRATION_INCOMPLETE";
    throw error;
  }
}

async function registerSourceDocumentsSafely(documents, sourceType) {
  try {
    return await registerSourceDocuments(documents, sourceType);
  } catch (error) {
    await rollbackUploadedDocuments({ documents });
    console.error(
      `Library source registration failed (${error.code || "UNKNOWN"}).`
    );
    throw new Error("The processed document could not be registered safely.");
  }
}

/**
 * Rolls back only artifacts created by the current upload attempt. Existing
 * workspace/vector state is never touched because registration happens before
 * callers may embed the new document.
 */
async function rollbackUploadedDocuments({
  file = null,
  original = null,
  documents = [],
} = {}) {
  const docpaths = (documents || [])
    .map((document) => LibraryDocuments.canonicalDocpath(document?.location))
    .filter(Boolean);
  if (docpaths.length) {
    try {
      await LibraryDocuments.deleteByDocpaths(docpaths);
    } catch (error) {
      console.error(
        `Failed to clean library upload records (${error.code || "UNKNOWN"}).`
      );
    }
  }

  for (const document of documents || []) {
    try {
      await purgeSourceDocument(document?.location);
    } catch (error) {
      console.error(
        `Failed to clean a processed upload artifact (${error.code || "UNKNOWN"}).`
      );
    }
  }

  if (original?.originalStorageKey) {
    try {
      await cleanupStagedOriginal(original.originalStorageKey);
    } catch (error) {
      console.error(
        `Failed to clean a staged original (${error.code || "UNKNOWN"}).`
      );
    }
  }

  if (file?.path) {
    const stagedPath = path.resolve(file.path);
    try {
      if (isWithin(hotdirPath, stagedPath)) {
        const stat = await fs.promises.lstat(stagedPath);
        if (stat.isFile() || stat.isSymbolicLink())
          await fs.promises.unlink(stagedPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        console.error(
          `Failed to clean a hotdir upload (${error.code || "UNKNOWN"}).`
        );
    }
  }
}

async function processUploadedLibraryDocument({
  collector,
  file,
  body = {},
  metadata = {},
  folderName = null,
}) {
  let original = null;
  let documents = [];
  try {
    const originalBody = {
      ...body,
      ...(!body.originalRelativePath && folderName
        ? {
            originalRelativePath: `${folderName}/${
              body.originalFilename || file.originalname
            }`,
          }
        : {}),
    };
    original = await stageOriginalUpload(file, originalBody);
    const result = await collector.processDocument(file.originalname, metadata);
    documents = result?.documents || [];
    if (!result?.success || documents.length === 0) {
      await rollbackUploadedDocuments({ file, original, documents });
      return {
        success: false,
        reason:
          result?.reason ||
          (documents.length === 0
            ? "Document processing produced no documents."
            : "Document processing failed."),
        documents: [],
      };
    }

    if (folderName) moveProcessedDocsToFolder(documents, folderName);
    for (const document of documents) {
      const canonicalLocation = LibraryDocuments.canonicalDocpath(
        document.location
      );
      if (!canonicalLocation)
        throw new Error("Collector returned an invalid document location.");
      document.location = canonicalLocation;
    }
    const publicDocuments = await registerUploadedDocuments(
      documents,
      original
    );
    return {
      success: true,
      reason: null,
      documents: publicDocuments,
    };
  } catch (error) {
    await rollbackUploadedDocuments({ file, original, documents });
    console.error(
      `Persistent upload registration failed (${error.code || "UNKNOWN"}).`
    );
    return {
      success: false,
      reason: "The uploaded document could not be stored safely.",
      documents: [],
    };
  }
}

module.exports = {
  stageOriginalUpload,
  registerUploadedDocuments,
  registerSourceDocuments,
  registerSourceDocumentsSafely,
  rollbackUploadedDocuments,
  processUploadedLibraryDocument,
};
