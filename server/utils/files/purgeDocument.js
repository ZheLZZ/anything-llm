const fs = require("fs");
const path = require("path");
const {
  purgeVectorCache,
  purgeSourceDocument,
  normalizePath,
  isWithin,
  documentsPath,
} = require(".");
const { Document } = require("../../models/documents");
const { Workspace } = require("../../models/workspace");
const { LibraryDocuments } = require("../../models/libraryDocuments");
const { removeOriginalFile } = require("./originalDocumentStore");

async function removeOriginalWhenUnreferenced(originalStorageKey) {
  if (!originalStorageKey) return;
  const references =
    await LibraryDocuments.countReferencesToOriginalStorageKey(
      originalStorageKey
    );
  if (references > 0) return;
  try {
    await removeOriginalFile(originalStorageKey);
  } catch (error) {
    // Keep deletion failures non-fatal. The opaque key and absolute path are
    // intentionally omitted from logs; an orphan cleanup can retry later.
    console.error(
      `Failed to remove an unreferenced original (${error.code || "UNKNOWN"}).`
    );
  }
}

async function purgeDocument(filename = null) {
  if (!filename || !normalizePath(filename)) return;

  const libraryRecord = await LibraryDocuments.getByDocpath(filename);
  const workspaces = await Workspace.where();
  for (const workspace of workspaces) {
    await Document.removeDocuments(workspace, [filename]);
  }
  await purgeVectorCache(filename);
  await purgeSourceDocument(filename);

  const removed = await LibraryDocuments.deleteByDocpath(filename);
  await removeOriginalWhenUnreferenced(
    removed?.originalStorageKey || libraryRecord?.originalStorageKey
  );
  return;
}

/**
 * Purge a folder and all its contents. This will also remove all vector-cache files and workspace document associations
 * for the documents within the folder.
 * @notice This function is not recursive. It only purges the contents of the specified folder.
 * @notice You cannot purge the `custom-documents` folder.
 * @param {string} folderName - The name/path of the folder to purge.
 * @returns {Promise<void>}
 */
async function purgeFolder(folderName = null) {
  if (!folderName) return;
  const subFolder = normalizePath(folderName);
  const subFolderPath = path.resolve(documentsPath, subFolder);
  const validRemovableSubFolders = fs
    .readdirSync(documentsPath)
    .map((folder) => {
      // Filter out any results which are not folders or
      // are the protected custom-documents folder.
      if (folder === "custom-documents") return null;
      const subfolderPath = path.resolve(documentsPath, folder);
      if (!fs.lstatSync(subfolderPath).isDirectory()) return null;
      return folder;
    })
    .filter((subFolder) => !!subFolder);

  if (
    !validRemovableSubFolders.includes(subFolder) ||
    !fs.existsSync(subFolderPath) ||
    !isWithin(documentsPath, subFolderPath)
  )
    return;

  const filenames = fs
    .readdirSync(subFolderPath)
    .filter((file) => fs.lstatSync(path.join(subFolderPath, file)).isFile())
    .map((file) =>
      path
        .relative(documentsPath, path.join(subFolderPath, file))
        .split(path.sep)
        .join("/")
    );
  const libraryRecords = await LibraryDocuments.getByDocpaths(filenames);
  const workspaces = await Workspace.where();

  const purgePromises = [];
  // Remove associated Vector-cache files
  for (const filename of filenames) {
    const rmVectorCache = () =>
      new Promise((resolve) =>
        purgeVectorCache(filename).then(() => resolve(true))
      );
    purgePromises.push(rmVectorCache);
  }

  // Remove workspace document associations
  for (const workspace of workspaces) {
    const rmWorkspaceDoc = () =>
      new Promise((resolve) =>
        Document.removeDocuments(workspace, filenames).then(() => resolve(true))
      );
    purgePromises.push(rmWorkspaceDoc);
  }

  await Promise.all(purgePromises.flat().map((f) => f()));
  fs.rmSync(subFolderPath, { recursive: true }); // Delete target document-folder and source files.

  const removedRecords = await LibraryDocuments.deleteByDocpaths(filenames);
  const storageKeys = [
    ...new Set(
      [...libraryRecords, ...removedRecords]
        .map((record) => record.originalStorageKey)
        .filter(Boolean)
    ),
  ];
  const referenced =
    await LibraryDocuments.referencedOriginalStorageKeys(storageKeys);
  for (const storageKey of storageKeys) {
    if (referenced.has(storageKey)) continue;
    try {
      await removeOriginalFile(storageKey);
    } catch (error) {
      console.error(
        `Failed to remove an unreferenced original (${error.code || "UNKNOWN"}).`
      );
    }
  }

  return;
}

module.exports = {
  purgeDocument,
  purgeFolder,
};
