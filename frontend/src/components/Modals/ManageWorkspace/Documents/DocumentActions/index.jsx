import { useEffect, useRef, useState } from "react";
import {
  CircleNotch,
  DotsThreeVertical,
  DownloadSimple,
  PencilSimple,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import Document from "@/models/document";
import showToast from "@/utils/toast";
import {
  getDocumentEffectiveName,
  resolveDisplayNameRename,
} from "@/utils/documentLibrary";

export default function DocumentActions({ item, onUpdated }) {
  const { t } = useTranslation();
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event) => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const stopRowEvent = (event) => event.stopPropagation();
  const beginRename = (event) => {
    stopRowEvent(event);
    setDisplayName(getDocumentEffectiveName(item));
    setOpen(false);
    setRenaming(true);
  };

  const saveRename = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!item.libraryDocumentId || saving) return;

    setSaving(true);
    const { result, document: updatedDocument } =
      await resolveDisplayNameRename({
        document: item,
        displayName,
        rename: Document.renameDisplayName,
      });
    setSaving(false);
    if (!result.success) {
      showToast(
        result.message ||
          t("document_library.rename_failed", {
            defaultValue: "Failed to rename document.",
          }),
        "error"
      );
      return;
    }

    onUpdated?.(updatedDocument);
    setRenaming(false);
    showToast(
      t("document_library.rename_success", {
        defaultValue: "Document display name updated.",
      }),
      "success"
    );
  };

  const downloadOriginal = async (event) => {
    stopRowEvent(event);
    if (!item.originalFileAvailable || !item.libraryDocumentId) return;
    setOpen(false);
    const result = await Document.downloadOriginal(item.libraryDocumentId);
    if (!result.success)
      showToast(
        result.error ||
          t("document_library.download_failed", {
            defaultValue: "Failed to download the original file.",
          }),
        "error"
      );
  };

  return (
    <div
      ref={menuRef}
      className="relative flex items-center"
      onClick={stopRowEvent}
      onMouseDown={stopRowEvent}
    >
      <button
        type="button"
        aria-label={t("document_library.document_actions", {
          defaultValue: "Document actions",
        })}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!item.libraryDocumentId}
        onClick={(event) => {
          stopRowEvent(event);
          setOpen((value) => !value);
        }}
        className="p-0.5 rounded hover:bg-theme-file-picker-hover disabled:opacity-40"
      >
        <DotsThreeVertical size={17} weight="bold" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-6 z-50 min-w-[220px] rounded-lg border border-theme-modal-border bg-theme-bg-secondary p-1 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={beginRename}
            className="w-full flex items-center gap-2 rounded px-3 py-2 text-left text-xs text-theme-text-primary hover:bg-theme-file-picker-hover"
          >
            <PencilSimple size={15} />
            {t("document_library.rename_document", {
              defaultValue: "Rename display name",
            })}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!item.originalFileAvailable}
            title={
              item.originalFileAvailable
                ? undefined
                : t("document_library.original_unavailable", {
                    defaultValue:
                      "This document has no downloadable original file. It may predate original-file retention or come from a web page or raw text.",
                  })
            }
            onClick={downloadOriginal}
            className="w-full flex items-center gap-2 rounded px-3 py-2 text-left text-xs text-theme-text-primary hover:bg-theme-file-picker-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <DownloadSimple size={15} />
            {t("document_library.download_original", {
              defaultValue: "Download original file",
            })}
          </button>
        </div>
      )}

      {renaming && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onMouseDown={(event) => {
            stopRowEvent(event);
            if (event.target === event.currentTarget && !saving)
              setRenaming(false);
          }}
        >
          <form
            onSubmit={saveRename}
            onClick={stopRowEvent}
            className="w-[420px] rounded-xl border border-theme-modal-border bg-theme-bg-secondary p-5 shadow-2xl"
          >
            <h3 className="mb-4 text-base font-semibold text-theme-text-primary">
              {t("document_library.rename_title", {
                defaultValue: "Rename document display name",
              })}
            </h3>
            <label className="mb-2 block text-xs text-theme-text-secondary">
              {t("document_library.display_name", {
                defaultValue: "Display name",
              })}
            </label>
            <input
              autoFocus
              value={displayName}
              onChange={(event) =>
                setDisplayName(
                  Array.from(event.target.value).slice(0, 255).join("")
                )
              }
              className="w-full rounded-lg border border-theme-modal-border bg-theme-settings-input-bg px-3 py-2 text-sm text-theme-text-primary outline-none focus:border-primary-button"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => setRenaming(false)}
                className="rounded-lg border border-theme-modal-border px-4 py-2 text-xs text-theme-text-primary disabled:opacity-50"
              >
                {t("chat_window.cancel")}
              </button>
              <button
                type="submit"
                disabled={saving || !displayName.trim()}
                className="flex items-center gap-2 rounded-lg bg-primary-button px-4 py-2 text-xs text-white disabled:opacity-50"
              >
                {saving && <CircleNotch size={14} className="animate-spin" />}
                {t("document_library.save_name", {
                  defaultValue: "Save name",
                })}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
