const fs = require("fs");
const path = require("path");
const { LibraryDocuments } = require("../../models/libraryDocuments");
const { documentsPath, isWithin } = require(".");

/**
 * Moves a processed JSON and, when a library record already exists, updates
 * its docpath. A database failure rolls the filesystem rename back so the two
 * sources of truth cannot be left pointing at different locations.
 */
async function moveLibraryDocument(from, to) {
  const sourceDocpath = LibraryDocuments.canonicalDocpath(from);
  const destinationDocpath = LibraryDocuments.canonicalDocpath(to);
  if (!sourceDocpath || !destinationDocpath)
    throw new Error("Invalid file location.");

  const sourcePath = path.resolve(documentsPath, sourceDocpath);
  const destinationPath = path.resolve(documentsPath, destinationDocpath);
  if (
    !isWithin(documentsPath, sourcePath) ||
    !isWithin(documentsPath, destinationPath)
  )
    throw new Error("Invalid file location.");

  const libraryRecord = await LibraryDocuments.getByDocpath(sourceDocpath);
  await fs.promises.rename(sourcePath, destinationPath);
  if (!libraryRecord) return true;

  try {
    await LibraryDocuments.updateDocpath(sourceDocpath, destinationDocpath);
    return true;
  } catch (error) {
    try {
      await fs.promises.rename(destinationPath, sourcePath);
    } catch (rollbackError) {
      console.error(
        `Document move rollback failed (${rollbackError.code || "UNKNOWN"}).`
      );
    }
    throw error;
  }
}

module.exports = { moveLibraryDocument };
