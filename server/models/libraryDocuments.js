const path = require("path");
const { v4: uuidv4 } = require("uuid");
const prisma = require("../utils/prisma");
const { originalExists } = require("../utils/files/originalDocumentStore");

const DISPLAY_NAME_MAX_LENGTH = 255;

function hasControlCharacters(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function canonicalDocpath(docpath) {
  if (typeof docpath !== "string") return null;
  const normalized = docpath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    path.win32.isAbsolute(normalized) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        hasControlCharacters(segment)
    )
  )
    return null;
  return normalized;
}

function displayNameFor(document = {}, docpath = "") {
  const safeDocpath = typeof docpath === "string" ? docpath : "";
  for (const candidate of [
    document.displayName,
    document.title,
    document.name,
    path.posix.basename(safeDocpath),
  ]) {
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  return "Untitled document";
}

function validateDisplayName(displayName) {
  if (typeof displayName !== "string") {
    const error = new Error("displayName must be a string.");
    error.code = "INVALID_DISPLAY_NAME";
    throw error;
  }
  const value = displayName.trim();
  if (!value) {
    const error = new Error("displayName cannot be empty.");
    error.code = "INVALID_DISPLAY_NAME";
    throw error;
  }
  if (
    Array.from(value).length > DISPLAY_NAME_MAX_LENGTH ||
    hasControlCharacters(value)
  ) {
    const error = new Error(
      `displayName must contain at most ${DISPLAY_NAME_MAX_LENGTH} characters and no control characters.`
    );
    error.code = "INVALID_DISPLAY_NAME";
    throw error;
  }
  return value;
}

function registrationInput(document, options = {}) {
  const docpath = canonicalDocpath(document?.location || document?.docpath);
  if (!docpath) return null;
  const processedDocumentId =
    document?.id ||
    document?.metadata?.id ||
    options.processedDocumentId ||
    null;
  return {
    docpath,
    processedDocumentId: processedDocumentId
      ? String(processedDocumentId)
      : null,
    displayName: displayNameFor(document, docpath),
    sourceType: options.sourceType || "unknown",
  };
}

function publicFields(record, available = false) {
  if (!record) return null;
  return {
    libraryDocumentId: record.id,
    displayName: record.displayName,
    effectiveName: record.displayName,
    sourceType: record.sourceType,
    originalFileAvailable: Boolean(record.originalStorageKey && available),
    originalFilename: record.originalFilename || null,
    originalRelativePath: record.originalRelativePath || null,
    originalMimeType: record.originalMimeType || null,
    originalSizeBytes: record.originalSizeBytes || null,
  };
}

function safePublicDocument(document = {}) {
  if (typeof document.url !== "string" || !/^file:/i.test(document.url))
    return document;
  const safeName = String(document.url).split(/[\\/]/).pop() || "document";
  return { ...document, url: `file://${safeName}` };
}

const LibraryDocuments = {
  canonicalDocpath,
  validateDisplayName,

  getById: async function (id) {
    if (!id) return null;
    return prisma.library_documents.findUnique({ where: { id: String(id) } });
  },

  getByDocpath: async function (docpath) {
    const normalized = canonicalDocpath(docpath);
    if (!normalized) return null;
    return prisma.library_documents.findUnique({
      where: { docpath: normalized },
    });
  },

  getByProcessedDocumentId: async function (processedDocumentId) {
    if (!processedDocumentId) return null;
    return prisma.library_documents.findUnique({
      where: { processedDocumentId: String(processedDocumentId) },
    });
  },

  getByDocpaths: async function (docpaths = []) {
    const paths = [...new Set(docpaths.map(canonicalDocpath).filter(Boolean))];
    if (!paths.length) return [];
    return prisma.library_documents.findMany({
      where: { docpath: { in: paths } },
    });
  },

  /**
   * Registers one or more parsed documents in one transaction. A single
   * original upload may produce multiple parsed documents, all sharing the
   * same originalStorageKey.
   */
  registerParsedDocuments: async function (documents = [], options = {}) {
    const byDocpath = new Map();
    for (const document of documents) {
      const input = registrationInput(document, options);
      if (input) byDocpath.set(input.docpath, input);
    }
    const inputs = [...byDocpath.values()];
    if (!inputs.length) return [];

    const processedIds = inputs
      .map((input) => input.processedDocumentId)
      .filter(Boolean);
    const existing = await prisma.library_documents.findMany({
      where: {
        OR: [
          { docpath: { in: inputs.map((input) => input.docpath) } },
          ...(processedIds.length
            ? [{ processedDocumentId: { in: processedIds } }]
            : []),
        ],
      },
    });
    const byExistingPath = new Map(
      existing.map((record) => [record.docpath, record])
    );
    const byExistingProcessedId = new Map(
      existing
        .filter((record) => record.processedDocumentId)
        .map((record) => [record.processedDocumentId, record])
    );

    const original = options.original || null;
    const now = new Date();
    const operations = inputs
      .map((input) => {
        const found =
          byExistingPath.get(input.docpath) ||
          byExistingProcessedId.get(input.processedDocumentId);
        const originalData = original
          ? {
              originalStorageKey: original.originalStorageKey,
              originalFilename: original.originalFilename,
              originalRelativePath: original.originalRelativePath,
              originalMimeType: original.originalMimeType,
              originalSizeBytes:
                original.originalSizeBytes === null ||
                original.originalSizeBytes === undefined
                  ? null
                  : String(original.originalSizeBytes),
              originalUploadedAt: original.originalUploadedAt,
            }
          : {};

        if (found) {
          const updateData = {
            ...(found.docpath !== input.docpath
              ? { docpath: input.docpath }
              : {}),
            ...(!found.processedDocumentId && input.processedDocumentId
              ? { processedDocumentId: input.processedDocumentId }
              : {}),
            ...(["legacy", "unknown"].includes(found.sourceType) &&
            !["legacy", "unknown"].includes(input.sourceType)
              ? { sourceType: input.sourceType }
              : {}),
            ...originalData,
          };
          if (!Object.keys(updateData).length) return null;
          return prisma.library_documents.update({
            where: { id: found.id },
            data: { ...updateData, lastUpdatedAt: now },
          });
        }

        const data = {
          id: uuidv4(),
          ...input,
          ...originalData,
          createdAt: now,
          lastUpdatedAt: now,
        };
        return prisma.library_documents.upsert({
          where: { docpath: input.docpath },
          create: data,
          update: {
            ...originalData,
            lastUpdatedAt: now,
          },
        });
      })
      .filter(Boolean);

    if (operations.length) await prisma.$transaction(operations);
    return this.getByDocpaths(inputs.map((input) => input.docpath));
  },

  ensureLegacyDocuments: async function (documents = [], docpaths = []) {
    const prepared = documents.map((document, index) => ({
      ...document,
      docpath: docpaths[index] || document.docpath || document.location,
    }));
    return this.registerParsedDocuments(prepared, { sourceType: "legacy" });
  },

  renameDisplayName: async function (id, displayName) {
    const value = validateDisplayName(displayName);
    return prisma.library_documents.update({
      where: { id: String(id) },
      data: { displayName: value, lastUpdatedAt: new Date() },
    });
  },

  updateDocpath: async function (from, to) {
    const oldPath = canonicalDocpath(from);
    const newPath = canonicalDocpath(to);
    if (!oldPath || !newPath) throw new Error("Invalid document path.");
    const existing = await this.getByDocpath(oldPath);
    if (!existing) return null;
    return prisma.library_documents.update({
      where: { id: existing.id },
      data: { docpath: newPath, lastUpdatedAt: new Date() },
    });
  },

  deleteByDocpath: async function (docpath) {
    const record = await this.getByDocpath(docpath);
    if (!record) return null;
    await prisma.library_documents.delete({ where: { id: record.id } });
    return record;
  },

  deleteByDocpaths: async function (docpaths = []) {
    const records = await this.getByDocpaths(docpaths);
    if (!records.length) return [];
    await prisma.library_documents.deleteMany({
      where: { id: { in: records.map((record) => record.id) } },
    });
    return records;
  },

  countReferencesToOriginalStorageKey: async function (originalStorageKey) {
    if (!originalStorageKey) return 0;
    return prisma.library_documents.count({ where: { originalStorageKey } });
  },

  referencedOriginalStorageKeys: async function (storageKeys = []) {
    const keys = [...new Set(storageKeys.filter(Boolean))];
    if (!keys.length) return new Set();
    const records = await prisma.library_documents.findMany({
      where: { originalStorageKey: { in: keys } },
      select: { originalStorageKey: true },
    });
    return new Set(records.map((record) => record.originalStorageKey));
  },

  searchByDisplayName: async function (searchTerm, limit = 50) {
    const term = String(searchTerm || "").trim();
    if (!term) return [];
    return prisma.library_documents.findMany({
      where: { displayName: { contains: term } },
      take: limit,
      orderBy: { lastUpdatedAt: "desc" },
    });
  },

  toPublicFields: async function (record) {
    const available = record?.originalStorageKey
      ? await originalExists(record.originalStorageKey)
      : false;
    return publicFields(record, available);
  },

  enrichPublicDocuments: async function (
    documents = [],
    { docpaths = [], ensureLegacy = true } = {}
  ) {
    if (!documents.length) return [];
    const paths = documents.map((document, index) =>
      canonicalDocpath(docpaths[index] || document.docpath || document.location)
    );
    if (ensureLegacy) await this.ensureLegacyDocuments(documents, paths);
    const records = await this.getByDocpaths(paths);
    const byPath = new Map(records.map((record) => [record.docpath, record]));
    const availability = new Map(
      await Promise.all(
        records.map(async (record) => [
          record.id,
          record.originalStorageKey
            ? await originalExists(record.originalStorageKey)
            : false,
        ])
      )
    );

    return documents.map((document, index) => {
      const safeDocument = safePublicDocument(document);
      const record = byPath.get(paths[index]);
      if (!record) {
        const effectiveName = displayNameFor(safeDocument, paths[index]);
        return {
          ...safeDocument,
          libraryDocumentId: null,
          displayName: effectiveName,
          effectiveName,
          originalFileAvailable: false,
          originalFilename: null,
          originalRelativePath: null,
          originalMimeType: null,
          originalSizeBytes: null,
        };
      }
      return {
        ...safeDocument,
        ...publicFields(record, availability.get(record.id)),
      };
    });
  },

  /** Adds aliases to vector/chat sources without changing stored vectors. */
  enrichSources: async function (sources = []) {
    const ids = [
      ...new Set(
        sources
          .map((source) => source?.id || source?.metadata?.id)
          .filter(Boolean)
          .map(String)
      ),
    ];
    if (!ids.length) return sources.map(safePublicDocument);
    const records = await prisma.library_documents.findMany({
      where: { processedDocumentId: { in: ids } },
    });
    const byId = new Map(
      records.map((record) => [record.processedDocumentId, record])
    );
    return sources.map((source) => {
      const safeSource = safePublicDocument(source);
      const processedId = source?.id || source?.metadata?.id;
      const record = byId.get(String(processedId || ""));
      if (!record) return safeSource;
      return {
        ...safeSource,
        displayName: record.displayName,
        effectiveTitle:
          record.displayName || source.effectiveTitle || source.title,
      };
    });
  },
};

module.exports = {
  LibraryDocuments,
  DISPLAY_NAME_MAX_LENGTH,
};
