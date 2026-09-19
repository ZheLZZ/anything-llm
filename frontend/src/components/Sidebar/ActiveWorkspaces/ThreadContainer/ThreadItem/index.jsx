import useScrollActiveItemIntoView from "@/hooks/useScrollActiveItemIntoView";
import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import { DotsThree, PencilSimple, Trash } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

const THREAD_CALLOUT_DETAIL_WIDTH = 26;
export default function ThreadItem({
  idx,
  activeIdx,
  isActive,
  workspace,
  thread,
  onRemove,
  hasNext,
  selectionMode = false,
  selected = false,
  onToggleSelection,
  selectionDisabled = false,
}) {
  const { t } = useTranslation();
  const { slug: urlSlug, threadSlug = null } = useParams();
  const workspaceSlug = workspace?.slug ?? urlSlug;
  const optionsContainer = useRef(null);
  const [showOptions, setShowOptions] = useState(false);
  const linkTo = thread.virtual
    ? "/"
    : !thread.slug
      ? paths.workspace.chat(workspaceSlug)
      : paths.workspace.thread(workspaceSlug, thread.slug);

  const { ref } = useScrollActiveItemIntoView({
    isActive,
    behavior: "instant",
    block: "center",
  });
  return (
    <div
      className="w-full relative flex h-[38px] items-center border-none rounded-lg"
      role="listitem"
    >
      {/* Curved line Element and leader if required */}
      <div
        style={{ width: THREAD_CALLOUT_DETAIL_WIDTH / 2 }}
        className={`${
          isActive
            ? "border-l-2 border-b-2 border-white light:border-blue-800 z-[2]"
            : "border-l border-b border-zinc-500 light:border-slate-400 z-[1]"
        } h-[50%] absolute top-0 left-3 rounded-bl-lg pointer-events-none`}
      ></div>
      {/* Downstroke border for next item */}
      {hasNext && (
        <div
          style={{ width: THREAD_CALLOUT_DETAIL_WIDTH / 2 }}
          className={`${
            idx <= activeIdx && !isActive
              ? "border-l-2 border-white light:border-blue-800 z-[2]"
              : "border-l border-zinc-500 light:border-slate-400 z-[1]"
          } h-[100%] absolute top-0 left-3 pointer-events-none`}
        ></div>
      )}

      {/* Curved line inline placeholder for spacing - not visible */}
      <div
        style={{ width: THREAD_CALLOUT_DETAIL_WIDTH + 8 }}
        className="h-full shrink-0"
      />
      <div
        className={`flex w-full min-w-0 items-center justify-between pr-2 group/thread relative ${isActive ? "bg-[var(--theme-sidebar-thread-selected)] light:bg-blue-200" : "hover:bg-theme-sidebar-subitem-hover light:hover:bg-slate-300"} rounded-[4px]`}
      >
        {selectionMode ? (
          <label
            className={`flex w-full min-w-0 items-center gap-2 pl-2 py-1 text-theme-text-primary ${thread.slug ? "cursor-pointer" : "opacity-50"}`}
            title={
              thread.slug ? thread.name : t("thread-management.unselectable")
            }
          >
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 accent-blue-600"
              checked={selected}
              disabled={selectionDisabled || !thread.slug || thread.virtual}
              aria-label={t("thread-management.select-thread", {
                name: thread.name,
              })}
              onChange={() => onToggleSelection(thread.slug)}
            />
            <span
              className="truncate text-sm"
              data-tooltip-id="workspace-thread-name"
              data-tooltip-content={thread.name}
            >
              {thread.name}
            </span>
          </label>
        ) : (
          <Link
            ref={ref}
            to={linkTo}
            data-tooltip-id="workspace-thread-name"
            data-tooltip-content={thread.name}
            className="w-full pl-2 py-1 overflow-hidden"
            aria-current={isActive ? "page" : ""}
          >
            <p
              className={`text-left text-sm truncate max-w-[150px] ${
                isActive
                  ? "font-semibold text-theme-text-primary light:text-blue-900"
                  : "text-theme-text-primary font-medium light:text-slate-800"
              }`}
            >
              {thread.name}
            </p>
          </Link>
        )}
        {!!thread.slug && !selectionMode && !thread.virtual && (
          <div ref={optionsContainer} className="flex items-center">
            <div className="flex items-center w-fit md:invisible md:group-hover/thread:visible md:group-focus-within/thread:visible gap-x-1">
              <button
                type="button"
                className="border-none"
                onClick={() => setShowOptions(!showOptions)}
                aria-label="Thread options"
              >
                <DotsThree
                  className="text-slate-300 light:text-theme-text-secondary hover:text-white hover:light:text-theme-text-primary"
                  size={25}
                />
              </button>
            </div>
            {showOptions && (
              <OptionsMenu
                containerRef={optionsContainer}
                workspace={workspace}
                thread={thread}
                onRemove={onRemove}
                close={() => setShowOptions(false)}
                currentThreadSlug={threadSlug}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OptionsMenu({
  containerRef,
  workspace,
  thread,
  onRemove,
  close,
  currentThreadSlug,
}) {
  const menuRef = useRef(null);

  // Ref menu options
  const outsideClick = (e) => {
    if (!menuRef.current) return false;
    if (
      !menuRef.current?.contains(e.target) &&
      !containerRef.current?.contains(e.target)
    )
      close();
    return false;
  };

  const isEsc = (e) => {
    if (e.key === "Escape" || e.key === "Esc") close();
  };

  function cleanupListeners() {
    window.removeEventListener("click", outsideClick);
    window.removeEventListener("keyup", isEsc);
  }
  // end Ref menu options

  useEffect(() => {
    function setListeners() {
      if (!menuRef?.current || !containerRef.current) return false;
      window.document.addEventListener("click", outsideClick);
      window.document.addEventListener("keyup", isEsc);
    }

    setListeners();
    return cleanupListeners;
  }, [menuRef.current, containerRef.current]);

  const renameThread = async () => {
    const name = window
      .prompt("What would you like to rename this thread to?")
      ?.trim();
    if (!name || name.length === 0) {
      close();
      return;
    }

    const { message } = await Workspace.threads.update(
      workspace.slug,
      thread.slug,
      { name }
    );
    if (!!message) {
      showToast(`Thread could not be updated! ${message}`, "error", {
        clear: true,
      });
      close();
      return;
    }

    thread.name = name;
    close();
  };

  const handleDelete = async () => {
    if (
      !window.confirm(
        "Are you sure you want to delete this thread? All of its chats will be deleted. You cannot undo this."
      )
    )
      return;
    const success = await Workspace.threads.delete(workspace.slug, thread.slug);
    if (!success) {
      showToast("Thread could not be deleted!", "error", { clear: true });
      return;
    }
    if (success) {
      showToast("Thread deleted successfully!", "success", { clear: true });
      onRemove(thread.id);
      // Redirect if deleting the active thread
      if (currentThreadSlug === thread.slug) {
        window.location.href = paths.workspace.chat(workspace.slug);
      }
      return;
    }
  };

  return (
    <div
      ref={menuRef}
      className="absolute w-fit z-[20] top-[25px] right-[10px] bg-zinc-900 light:bg-theme-bg-sidebar light:border-[1px] light:border-theme-sidebar-border rounded-lg p-1"
    >
      <button
        onClick={renameThread}
        type="button"
        className="w-full rounded-md flex items-center p-2 gap-x-2 hover:bg-slate-500/20 text-slate-300 light:text-theme-text-primary"
      >
        <PencilSimple size={18} />
        <p className="text-sm">Rename</p>
      </button>
      <button
        onClick={handleDelete}
        type="button"
        className="w-full rounded-md flex items-center p-2 gap-x-2 hover:bg-red-500/20 text-slate-300 light:text-theme-text-primary hover:text-red-100"
      >
        <Trash size={18} />
        <p className="text-sm">Delete Thread</p>
      </button>
    </div>
  );
}
