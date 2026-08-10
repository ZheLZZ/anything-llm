import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import {
  buildOriginalDownloadUrl,
  triggerNativeDownload,
} from "@/utils/documentLibrary";

const Document = {
  createFolder: async (name) => {
    return await fetch(`${API_BASE}/document/create-folder`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ name }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  moveToFolder: async (files, folderName) => {
    const data = {
      files: files.map((file) => ({
        from: file.folderName ? `${file.folderName}/${file.name}` : file.name,
        to: `${folderName}/${file.name}`,
      })),
    };

    return await fetch(`${API_BASE}/document/move-files`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(data),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  renameDisplayName: async (libraryDocumentId, displayName) => {
    return fetch(
      `${API_BASE}/document/${encodeURIComponent(libraryDocumentId)}/display-name`,
      {
        method: "PATCH",
        headers: baseHeaders(),
        body: JSON.stringify({ displayName }),
      }
    )
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.message || "Failed to rename document.");
        return data;
      })
      .catch((error) => ({ success: false, message: error.message }));
  },
  downloadOriginal: async (libraryDocumentId) => {
    return fetch(
      `${API_BASE}/document/${encodeURIComponent(libraryDocumentId)}/original-download-token`,
      { method: "POST", headers: baseHeaders() }
    )
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.message || "Original file is unavailable.");

        triggerNativeDownload(
          buildOriginalDownloadUrl(API_BASE, libraryDocumentId, data.token),
          window.document
        );
        return { success: true, error: null };
      })
      .catch((error) => ({ success: false, error: error.message }));
  },
};

export default Document;
