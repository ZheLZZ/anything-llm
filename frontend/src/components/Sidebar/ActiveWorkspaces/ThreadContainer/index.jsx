import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import { Plus, CircleNotch, ListChecks } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import ThreadItem from "./ThreadItem";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
export const THREAD_RENAME_EVENT = "renameThread";

export default function ThreadContainer({
  workspace,
  isVirtualThread = false,
}) {
  const { threadSlug = null } = useParams();
  const [threads, setThreads] = useState([]);
  const [defaultThreadHasChats, setDefaultThreadHasChats] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedSlugs, setSelectedSlugs] = useState([]);
  const [deleting, setDeleting] = useState(false);
  const deletePending = useRef(false);
  const { t } = useTranslation();
  const selected = threads.filter((thread) =>
    selectedSlugs.includes(thread.slug)
  );

  useEffect(() => {
    setSelectionMode(false);
    setSelectedSlugs([]);
  }, [workspace.slug]);

  useEffect(() => {
    const chatHandler = (event) => {
      const { threadSlug, newName } = event.detail;
      setThreads((prevThreads) =>
        prevThreads.map((thread) => {
          if (thread.slug === threadSlug) {
            return { ...thread, name: newName };
          }
          return thread;
        })
      );
    };

    window.addEventListener(THREAD_RENAME_EVENT, chatHandler);

    return () => {
      window.removeEventListener(THREAD_RENAME_EVENT, chatHandler);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchThreads() {
      if (!workspace.slug) return;
      const { threads, defaultThreadChatCount } = await Workspace.threads.all(
        workspace.slug
      );
      if (cancelled) return;
      setLoading(false);
      setThreads(threads);
      setDefaultThreadHasChats(defaultThreadChatCount > 0);
    }
    fetchThreads();
    return () => {
      cancelled = true;
    };
  }, [workspace.slug, threadSlug]);

  const toggleSelection = (slug) => {
    if (deletePending.current) return;
    setSelectedSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    );
  };

  const handleDeleteAll = async () => {
    if (deletePending.current || selected.length === 0) return;
    const slugs = selected.map((thread) => thread.slug);
    if (
      !window.confirm(
        t("thread-management.confirm", {
          count: slugs.length,
          workspace: workspace.name,
        })
      )
    )
      return;

    deletePending.current = true;
    setDeleting(true);
    try {
      const success = await Workspace.threads.deleteBulk(workspace.slug, slugs);
      if (!success) throw new Error("Thread deletion failed");
      setThreads((prev) =>
        prev.filter((thread) => !slugs.includes(thread.slug))
      );
      setSelectedSlugs([]);
      setSelectionMode(false);
      showToast(
        t("thread-management.success", { count: slugs.length }),
        "success",
        { clear: true }
      );
      if (slugs.includes(threadSlug)) {
        window.location.href = paths.workspace.chat(workspace.slug);
      }
    } catch {
      showToast(t("thread-management.failed"), "error", { clear: true });
    } finally {
      deletePending.current = false;
      setDeleting(false);
    }
  };

  function removeThread(threadId) {
    setThreads((prev) => prev.filter((thread) => thread.id !== threadId));
  }

  function getActiveThreadIdx() {
    if (isVirtualThread)
      return threads.length + (defaultThreadHasChats ? 1 : 0);
    // On a bare workspace route with no default chats, show virtual thread as active
    if (!threadSlug && !defaultThreadHasChats)
      return threads.length + (defaultThreadHasChats ? 1 : 0);
    const idx = threads.findIndex((t) => t?.slug === threadSlug);
    if (idx >= 0) return idx + (defaultThreadHasChats ? 1 : 0);
    if (!threadSlug && defaultThreadHasChats) return 0;
    return -1;
  }

  if (loading) {
    return (
      <div className="flex flex-col bg-pulse w-full h-10 items-center justify-center">
        <p className="text-xs text-white animate-pulse">loading threads....</p>
      </div>
    );
  }

  const activeThreadIdx = getActiveThreadIdx();

  // Show a virtual thread when on a bare workspace route (no threadSlug) and
  // the default thread has no chats — mimics the Home page virtual thread behavior.
  const showVirtualThread =
    isVirtualThread || (!threadSlug && !defaultThreadHasChats);

  return (
    <div className="flex flex-col">
      {threads.length > 0 && (
        <div
          className="sticky top-0 z-10 bg-theme-bg-sidebar light:bg-slate-200 py-2 px-1 border-b border-theme-sidebar-border light:border-slate-300"
          role="group"
          aria-label={t("thread-management.manage")}
        >
          {selectionMode ? (
            <div className="flex flex-col gap-2 text-xs text-theme-text-primary">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-blue-600"
                    disabled={deleting}
                    checked={selected.length === threads.length}
                    ref={(input) => {
                      if (input)
                        input.indeterminate =
                          selected.length > 0 &&
                          selected.length < threads.length;
                    }}
                    onChange={(event) =>
                      setSelectedSlugs(
                        event.target.checked
                          ? threads.map((thread) => thread.slug)
                          : []
                      )
                    }
                  />
                  {t("thread-management.select-all")}
                </label>
                <span role="status">
                  {t("thread-management.selected", { count: selected.length })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={deleting || selected.length === 0}
                  onClick={handleDeleteAll}
                  className="flex-1 rounded-md bg-red-600 px-2 py-1.5 text-white light:!text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {deleting
                    ? t("thread-management.deleting")
                    : t("thread-management.delete", { count: selected.length })}
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => {
                    setSelectionMode(false);
                    setSelectedSlugs([]);
                  }}
                  className="rounded-md px-2 py-1.5 hover:bg-theme-sidebar-subitem-hover disabled:opacity-40"
                >
                  {t("thread-management.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSelectionMode(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-theme-text-primary hover:bg-theme-sidebar-subitem-hover"
            >
              <ListChecks size={16} />
              {t("thread-management.manage")}
            </button>
          )}
        </div>
      )}
      <div role="list" aria-label="Threads">
        {defaultThreadHasChats && (
          <ThreadItem
            idx={0}
            activeIdx={activeThreadIdx}
            isActive={activeThreadIdx === 0}
            workspace={workspace}
            thread={{ slug: null, name: "default" }}
            selectionMode={selectionMode}
            hasNext={threads.length > 0 || showVirtualThread}
          />
        )}
        {threads.map((thread, i) => (
          <ThreadItem
            key={thread.slug}
            idx={i + (defaultThreadHasChats ? 1 : 0)}
            selectionMode={selectionMode}
            selected={selectedSlugs.includes(thread.slug)}
            onToggleSelection={toggleSelection}
            selectionDisabled={deleting}
            activeIdx={activeThreadIdx}
            isActive={activeThreadIdx === i + (defaultThreadHasChats ? 1 : 0)}
            workspace={workspace}
            onRemove={removeThread}
            thread={thread}
            hasNext={i !== threads.length - 1 || showVirtualThread}
          />
        ))}
        {showVirtualThread && (
          <ThreadItem
            idx={activeThreadIdx}
            activeIdx={activeThreadIdx}
            isActive={true}
            workspace={workspace}
            thread={{ slug: null, name: "*New Thread", virtual: true }}
            selectionMode={selectionMode}
            hasNext={false}
          />
        )}
      </div>
      {!selectionMode && <NewThreadButton workspace={workspace} />}
    </div>
  );
}

function NewThreadButton({ workspace }) {
  const [loading, setLoading] = useState(false);
  const onClick = async () => {
    setLoading(true);
    const { thread, error } = await Workspace.threads.new(workspace.slug);
    if (!!error) {
      showToast(`Could not create thread - ${error}`, "error", { clear: true });
      setLoading(false);
      return;
    }
    window.location.replace(
      paths.workspace.thread(workspace.slug, thread.slug)
    );
  };

  return (
    <button
      onClick={onClick}
      className="w-full relative flex h-[40px] items-center border-none hover:bg-[var(--theme-sidebar-thread-selected)] light:hover:bg-slate-300 hover:light:bg-theme-sidebar-subitem-hover rounded-lg"
    >
      <div className="flex w-full gap-x-2 items-center pl-4">
        <div className="bg-zinc-800 light:bg-slate-50 p-2 rounded-lg h-[24px] w-[24px] flex items-center justify-center">
          {loading ? (
            <CircleNotch
              weight="bold"
              size={14}
              className="shrink-0 animate-spin text-white light:text-theme-text-primary"
            />
          ) : (
            <Plus
              weight="bold"
              size={14}
              className="shrink-0 text-white light:text-theme-text-primary"
            />
          )}
        </div>

        {loading ? (
          <p className="text-left text-white light:text-theme-text-primary text-sm">
            Starting Thread...
          </p>
        ) : (
          <p className="text-left text-white light:text-theme-text-primary text-sm font-semibold">
            New Thread
          </p>
        )}
      </div>
    </button>
  );
}
