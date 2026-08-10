export function getDocumentEffectiveName(document = {}) {
  return (
    document.displayName?.trim() ||
    document.effectiveName?.trim() ||
    document.title ||
    document.name ||
    "Untitled document"
  );
}

export function getSourceEffectiveTitle(source = {}) {
  return (
    source.displayName?.trim() ||
    source.effectiveTitle?.trim() ||
    source.title ||
    "Untitled document"
  );
}

export function isSameLibraryDocument(left = {}, right = {}) {
  if (left.libraryDocumentId && right.libraryDocumentId)
    return left.libraryDocumentId === right.libraryDocumentId;
  return Boolean(left.id && right.id && left.id === right.id);
}

export function mergeLibraryDocumentMetadata(document, update) {
  return isSameLibraryDocument(document, update)
    ? { ...document, ...update }
    : document;
}

export function documentRowMetadataIsEqual(left = {}, right = {}) {
  return (
    left.id === right.id &&
    getDocumentEffectiveName(left) === getDocumentEffectiveName(right) &&
    left.originalFileAvailable === right.originalFileAvailable &&
    left.libraryDocumentId === right.libraryDocumentId
  );
}

export function updateDocumentMetadataCollections(state, update) {
  const updateItems = (items = []) =>
    items.map((item) => mergeLibraryDocumentMetadata(item, update));
  return {
    ...state,
    contents: Object.fromEntries(
      Object.entries(state.contents).map(([name, entry]) => [
        name,
        { ...entry, items: updateItems(entry.items) },
      ])
    ),
    searchResults:
      state.searchResults?.map((folder) => ({
        ...folder,
        items: updateItems(folder.items),
      })) ?? null,
    workspaceDocs: {
      ...state.workspaceDocs,
      items: state.workspaceDocs.items.map((folder) => ({
        ...folder,
        items: updateItems(folder.items),
      })),
    },
  };
}

export async function resolveDisplayNameRename({
  document,
  displayName,
  rename,
}) {
  const result = await rename(document.libraryDocumentId, displayName);
  return {
    result,
    document: result.success ? { ...document, ...result.document } : document,
  };
}

export function buildOriginalDownloadUrl(apiBase, libraryDocumentId, token) {
  return `${apiBase}/document/${encodeURIComponent(
    libraryDocumentId
  )}/original?token=${encodeURIComponent(token)}`;
}

export function triggerNativeDownload(url, documentRef = globalThis.document) {
  if (!documentRef?.createElement || !documentRef?.body)
    throw new Error("A browser document is required to start the download.");
  const anchor = documentRef.createElement("a");
  anchor.href = url;
  anchor.style.display = "none";
  documentRef.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
