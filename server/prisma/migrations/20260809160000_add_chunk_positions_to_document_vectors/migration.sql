-- AlterTable
ALTER TABLE "document_vectors" ADD COLUMN "chunkIndex" INTEGER;
ALTER TABLE "document_vectors" ADD COLUMN "chunkCount" INTEGER;
ALTER TABLE "document_vectors" ADD COLUMN "chunkText" TEXT;

-- CreateIndex
CREATE INDEX "document_vectors_vectorId_idx" ON "document_vectors"("vectorId");

-- CreateIndex
CREATE INDEX "document_vectors_docId_chunkIndex_idx" ON "document_vectors"("docId", "chunkIndex");
