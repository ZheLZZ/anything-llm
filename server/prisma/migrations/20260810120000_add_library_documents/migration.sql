-- CreateTable
CREATE TABLE "library_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "processedDocumentId" TEXT,
    "docpath" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'unknown',
    "originalStorageKey" TEXT,
    "originalFilename" TEXT,
    "originalRelativePath" TEXT,
    "originalMimeType" TEXT,
    "originalSizeBytes" TEXT,
    "originalUploadedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "library_documents_processedDocumentId_key" ON "library_documents"("processedDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "library_documents_docpath_key" ON "library_documents"("docpath");

-- CreateIndex
CREATE INDEX "library_documents_originalStorageKey_idx" ON "library_documents"("originalStorageKey");
