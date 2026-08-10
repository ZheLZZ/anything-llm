import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildOriginalDownloadUrl,
  documentRowMetadataIsEqual,
  getDocumentEffectiveName,
  getSourceEffectiveTitle,
  resolveDisplayNameRename,
  triggerNativeDownload,
  updateDocumentMetadataCollections,
} from "./documentLibrary.js";

test("displayName is the presentation name for library rows and citations", () => {
  const document = {
    displayName: "沐曦招股书（2026申报稿）",
    title: "Immutable processed title",
    name: "immutable.json",
  };
  assert.equal(getDocumentEffectiveName(document), "沐曦招股书（2026申报稿）");
  assert.equal(getSourceEffectiveTitle(document), document.displayName);
});

test("successful rename updates every loaded library and workspace copy", () => {
  const original = {
    id: "processed-1",
    libraryDocumentId: "library-1",
    displayName: "Old name",
  };
  const untouched = {
    id: "processed-2",
    libraryDocumentId: "library-2",
    displayName: "Other",
  };
  const selectedFiles = new Set([original.id]);
  const state = {
    contents: {
      folder: { status: "loaded", items: [original, untouched] },
    },
    searchResults: [{ name: "folder", items: [original] }],
    workspaceDocs: {
      name: "documents",
      items: [{ name: "folder", items: [original] }],
    },
    selectedFiles,
  };

  const next = updateDocumentMetadataCollections(state, {
    libraryDocumentId: "library-1",
    displayName: "New name",
  });

  assert.equal(next.contents.folder.items[0].displayName, "New name");
  assert.equal(next.searchResults[0].items[0].displayName, "New name");
  assert.equal(next.workspaceDocs.items[0].items[0].displayName, "New name");
  assert.equal(next.contents.folder.items[1], untouched);
  assert.equal(next.selectedFiles, selectedFiles);
});

test("failed rename keeps the original row object for rollback", async () => {
  const document = {
    libraryDocumentId: "library-1",
    displayName: "Old name",
  };
  const outcome = await resolveDisplayNameRename({
    document,
    displayName: "New name",
    rename: async () => ({ success: false, message: "database failed" }),
  });
  assert.equal(outcome.result.success, false);
  assert.equal(outcome.document, document);
});

test("successful rename produces an immediately mergeable row", async () => {
  const document = {
    id: "processed-1",
    libraryDocumentId: "library-1",
    displayName: "Old name",
  };
  const outcome = await resolveDisplayNameRename({
    document,
    displayName: "New name",
    rename: async () => ({
      success: true,
      document: { libraryDocumentId: "library-1", displayName: "New name" },
    }),
  });
  assert.equal(outcome.document.displayName, "New name");
  assert.equal(outcome.document.id, "processed-1");
});

test("memo comparison detects display and original availability changes", () => {
  const before = {
    id: "processed-1",
    libraryDocumentId: "library-1",
    displayName: "Old name",
    originalFileAvailable: false,
  };
  assert.equal(documentRowMetadataIsEqual(before, { ...before }), true);
  assert.equal(
    documentRowMetadataIsEqual(before, {
      ...before,
      displayName: "New name",
    }),
    false
  );
  assert.equal(
    documentRowMetadataIsEqual(before, {
      ...before,
      originalFileAvailable: true,
    }),
    false
  );
});

test("native download uses a short token URL and never buffers a blob", () => {
  const events = [];
  const anchor = {
    style: {},
    click: () => events.push("clicked"),
    remove: () => events.push("removed"),
  };
  const documentRef = {
    createElement: (tag) => {
      assert.equal(tag, "a");
      return anchor;
    },
    body: {
      appendChild: (element) => {
        assert.equal(element, anchor);
        events.push("appended");
      },
    },
  };
  const url = buildOriginalDownloadUrl(
    "/api",
    "library/id",
    "short token&bound"
  );
  triggerNativeDownload(url, documentRef);
  assert.equal(
    anchor.href,
    "/api/document/library%2Fid/original?token=short%20token%26bound"
  );
  assert.deepEqual(events, ["appended", "clicked", "removed"]);
});

test("both document panels expose the shared rename and download actions", async () => {
  const paths = [
    new URL(
      "../components/Modals/ManageWorkspace/Documents/Directory/FileRow/index.jsx",
      import.meta.url
    ),
    new URL(
      "../components/Modals/ManageWorkspace/Documents/WorkspaceDirectory/WorkspaceFileRow/index.jsx",
      import.meta.url
    ),
  ];
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    assert.match(source, /getDocumentEffectiveName\(item\)/);
    assert.match(source, /<DocumentActions item=\{item\}/);
  }

  const model = await readFile(
    new URL("../models/document.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(model, /\.blob\s*\(/);

  const actions = await readFile(
    new URL(
      "../components/Modals/ManageWorkspace/Documents/DocumentActions/index.jsx",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(actions, /onClick=\{stopRowEvent\}/);
  assert.match(actions, /onMouseDown=\{stopRowEvent\}/);
  assert.match(actions, /disabled=\{!item\.originalFileAvailable\}/);
});
