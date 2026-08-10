const { Document } = require("../models/documents");
const { normalizePath, documentsPath, isWithin } = require("../utils/files");
const { reqBody } = require("../utils/http");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const fs = require("fs");
const path = require("path");
const { moveLibraryDocument } = require("../utils/files/moveLibraryDocument");
const { LibraryDocuments } = require("../models/libraryDocuments");
const { EventLogs } = require("../models/eventLogs");
const {
  ORIGINAL_DOCUMENT_DOWNLOAD_PURPOSE,
  createOriginalDocumentDownloadToken,
  verifyOriginalDocumentDownloadToken,
  streamOriginalFile,
} = require("../utils/files/originalDocumentStore");

function originalUnavailable(response, code, message) {
  return response.status(404).json({ success: false, code, message });
}

async function sendOriginalDocument(response, libraryDocument) {
  if (!libraryDocument?.originalStorageKey)
    return originalUnavailable(
      response,
      "ORIGINAL_NOT_AVAILABLE",
      "The original uploaded file is not available for this document."
    );

  const sent = await streamOriginalFile({
    response,
    storageKey: libraryDocument.originalStorageKey,
    downloadFilename: libraryDocument.originalFilename,
    mimeType: libraryDocument.originalMimeType,
  });
  if (!sent)
    return originalUnavailable(
      response,
      "ORIGINAL_FILE_MISSING",
      "The stored original file could not be found."
    );
  return response;
}

function documentEndpoints(app) {
  if (!app) return;
  app.post(
    "/document/create-folder",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        const storagePath = path.join(documentsPath, normalizePath(name));
        if (!isWithin(path.resolve(documentsPath), path.resolve(storagePath)))
          throw new Error("Invalid folder name.");

        if (fs.existsSync(storagePath)) {
          response.status(500).json({
            success: false,
            message: "Folder by that name already exists",
          });
          return;
        }

        fs.mkdirSync(storagePath, { recursive: true });
        response.status(200).json({ success: true, message: null });
      } catch (e) {
        console.error(e);
        response.status(500).json({
          success: false,
          message: `Failed to create folder: ${e.message} `,
        });
      }
    }
  );

  app.post(
    "/document/move-files",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { files } = reqBody(request);
        const requestedFiles = files.map(({ from, to }) => ({
          from: LibraryDocuments.canonicalDocpath(from),
          to: LibraryDocuments.canonicalDocpath(to),
        }));
        if (requestedFiles.some(({ from, to }) => !from || !to))
          throw new Error("Invalid file location.");

        const docpaths = requestedFiles.map(({ from }) => from);
        const docpathVariants = [
          ...new Set(
            docpaths.flatMap((docpath) => [
              docpath,
              docpath.replace(/\//g, "\\"),
            ])
          ),
        ];
        const documents = await Document.where({
          docpath: { in: docpathVariants },
        });

        const embeddedFiles = new Set(
          documents
            .map((doc) => LibraryDocuments.canonicalDocpath(doc.docpath))
            .filter(Boolean)
        );
        const moveableFiles = requestedFiles.filter(
          ({ from }) => !embeddedFiles.has(from)
        );

        await Promise.all(
          moveableFiles.map(({ from, to }) => moveLibraryDocument(from, to))
        );
        const unmovableCount = files.length - moveableFiles.length;
        response.status(200).json({
          success: true,
          message:
            unmovableCount > 0
              ? `${unmovableCount}/${files.length} files not moved. Unembed them from all workspaces.`
              : null,
        });
      } catch (e) {
        console.error(e);
        response
          .status(500)
          .json({ success: false, message: "Failed to move files." });
      }
    }
  );

  app.patch(
    "/document/:libraryDocumentId/display-name",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { libraryDocumentId } = request.params;
        const existing = await LibraryDocuments.getById(libraryDocumentId);
        if (!existing)
          return response.status(404).json({
            success: false,
            code: "LIBRARY_DOCUMENT_NOT_FOUND",
            message: "Library document not found.",
          });

        const { displayName } = reqBody(request);
        const updated = await LibraryDocuments.renameDisplayName(
          libraryDocumentId,
          displayName
        );
        await EventLogs.logEvent(
          "library_document_display_name_updated",
          {
            libraryDocumentId: updated.id,
            oldDisplayName: existing.displayName,
            newDisplayName: updated.displayName,
          },
          response.locals?.user?.id
        );
        response.status(200).json({
          success: true,
          document: await LibraryDocuments.toPublicFields(updated),
          reindexed: false,
        });
      } catch (error) {
        response
          .status(error.code === "INVALID_DISPLAY_NAME" ? 422 : 500)
          .json({
            success: false,
            code: error.code || "DISPLAY_NAME_UPDATE_FAILED",
            message:
              error.code === "INVALID_DISPLAY_NAME"
                ? error.message
                : "Failed to update the display name.",
          });
      }
    }
  );

  app.post(
    "/document/:libraryDocumentId/original-download-token",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { libraryDocumentId } = request.params;
        const document = await LibraryDocuments.getById(libraryDocumentId);
        if (!document)
          return response.status(404).json({
            success: false,
            code: "LIBRARY_DOCUMENT_NOT_FOUND",
            message: "Library document not found.",
          });
        if (!document.originalStorageKey)
          return originalUnavailable(
            response,
            "ORIGINAL_NOT_AVAILABLE",
            "The original uploaded file is not available for this document."
          );

        const token = createOriginalDocumentDownloadToken(document.id);
        response.status(200).json({ success: true, token, expiresIn: 60 });
      } catch (error) {
        console.error(
          "Original document download token creation failed (" +
            (error.code || "UNKNOWN") +
            ")."
        );
        response.status(500).json({
          success: false,
          code: "DOWNLOAD_TOKEN_FAILED",
          message: "Failed to create an original document download token.",
        });
      }
    }
  );

  app.get(
    "/document/:libraryDocumentId/original",
    async (request, response) => {
      try {
        const { libraryDocumentId } = request.params;
        const token = verifyOriginalDocumentDownloadToken(request.query?.token);
        if (
          token?.purpose !== ORIGINAL_DOCUMENT_DOWNLOAD_PURPOSE ||
          token?.libraryDocumentId !== libraryDocumentId
        )
          return response.status(401).json({
            success: false,
            code: "INVALID_DOWNLOAD_TOKEN",
            message:
              "The original document download token is invalid or expired.",
          });

        const document = await LibraryDocuments.getById(libraryDocumentId);
        if (!document)
          return response.status(404).json({
            success: false,
            code: "LIBRARY_DOCUMENT_NOT_FOUND",
            message: "Library document not found.",
          });
        return sendOriginalDocument(response, document);
      } catch {
        if (response.headersSent) return;
        response.status(500).json({
          success: false,
          code: "ORIGINAL_DOWNLOAD_FAILED",
          message: "Failed to download the original document.",
        });
      }
    }
  );
}

module.exports = { documentEndpoints, sendOriginalDocument };
