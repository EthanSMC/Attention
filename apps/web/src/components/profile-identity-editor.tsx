"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";

import {
  profileNameEditorWidth,
  shouldSubmitProfileNameEnter,
} from "./profile-name-editor-behavior";
import { TransientFeedback, useTransientFeedback } from "./transient-feedback";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const AVATAR_SIZE = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const DEFAULT_PREVIEW_SIZE = 240;

interface AvatarImageDraft {
  naturalHeight: number;
  naturalWidth: number;
  src: string;
}

interface AvatarCrop {
  offsetX: number;
  offsetY: number;
  previewSize: number;
  zoom: number;
}

interface CropOffset {
  x: number;
  y: number;
}

async function imageElement(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

async function avatarImageDraft(file: File): Promise<AvatarImageDraft> {
  if (!file.type.startsWith("image/") || file.size > MAX_INPUT_BYTES) {
    throw new RangeError("invalid_avatar_file");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await imageElement(objectUrl);
    if (image.naturalWidth < 1 || image.naturalHeight < 1) {
      throw new RangeError("invalid_avatar_file");
    }
    return {
      naturalHeight: image.naturalHeight,
      naturalWidth: image.naturalWidth,
      src: objectUrl,
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function avatarDataUrl(
  draft: AvatarImageDraft,
  crop: AvatarCrop,
): Promise<string> {
  const image = await imageElement(draft.src);
  const sourceSize = Math.min(draft.naturalWidth, draft.naturalHeight);
  const outputScale = AVATAR_SIZE / sourceSize;
  const renderedWidth = draft.naturalWidth * outputScale * crop.zoom;
  const renderedHeight = draft.naturalHeight * outputScale * crop.zoom;
  const offsetScale = AVATAR_SIZE / Math.max(crop.previewSize, 1);

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    (AVATAR_SIZE - renderedWidth) / 2 + crop.offsetX * offsetScale,
    (AVATAR_SIZE - renderedHeight) / 2 + crop.offsetY * offsetScale,
    renderedWidth,
    renderedHeight,
  );

  const webp = canvas.toDataURL("image/webp", 0.82);
  if (webp.startsWith("data:image/webp;base64,")) return webp;
  return canvas.toDataURL("image/jpeg", 0.86);
}

export function ProfileIdentityEditor({
  attentionId,
  avatarUrl: initialAvatarUrl,
  displayName: initialDisplayName,
  isFilter,
  isMember,
}: {
  attentionId: string | null;
  avatarUrl: string | null;
  displayName: string;
  isFilter: boolean;
  isMember: boolean;
}) {
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [draftName, setDraftName] = useState(initialDisplayName);
  const [avatarDraft, setAvatarDraft] = useState<AvatarImageDraft | null>(null);
  const [editorWidth, setEditorWidth] = useState<number | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [busy, setBusy] = useState<"avatar" | "name" | null>(null);
  const { feedback, showFeedback } = useTransientFeedback();
  const avatarButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const profileCopyRef = useRef<HTMLDivElement>(null);
  const nameMeasureRef = useRef<HTMLSpanElement>(null);
  const nameActionsRef = useRef<HTMLSpanElement>(null);
  const initialNameEditorWidthRef = useRef(0);
  const nameCompositionActiveRef = useRef(false);
  const avatarDraftRef = useRef<AvatarImageDraft | null>(null);
  const avatarInitial = Array.from(displayName.trim()).at(0) ?? "A";

  useEffect(() => {
    return () => {
      if (avatarDraftRef.current) URL.revokeObjectURL(avatarDraftRef.current.src);
    };
  }, []);

  useLayoutEffect(() => {
    if (!editingName) return;

    const updateWidth = () => {
      const copy = profileCopyRef.current;
      const measure = nameMeasureRef.current;
      if (!copy || !measure) return;

      const actions = nameActionsRef.current;
      const actionSpace =
        actions && window.getComputedStyle(actions).position === "absolute"
          ? actions.getBoundingClientRect().width + 8
          : 0;
      setEditorWidth(
        profileNameEditorWidth({
          availableWidth: Math.max(
            0,
            copy.getBoundingClientRect().width - actionSpace,
          ),
          contentWidth: measure.getBoundingClientRect().width,
          initialWidth: initialNameEditorWidthRef.current,
        }),
      );
    };

    updateWidth();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateWidth);
    if (profileCopyRef.current) observer.observe(profileCopyRef.current);
    if (nameActionsRef.current) observer.observe(nameActionsRef.current);
    return () => observer.disconnect();
  }, [draftName, editingName]);

  function showToast(text: string, tone: "error" | "success" = "success") {
    showFeedback(text, tone);
  }

  function replaceAvatarDraft(next: AvatarImageDraft | null) {
    setAvatarDraft((current) => {
      if (current && current.src !== next?.src) URL.revokeObjectURL(current.src);
      avatarDraftRef.current = next;
      return next;
    });
  }

  function closeNameEditor(nextName = displayName) {
    nameCompositionActiveRef.current = false;
    setDraftName(nextName);
    setEditingName(false);
    requestAnimationFrame(() => nameButton.current?.focus());
  }

  async function updateProfile(body: {
    avatar_url?: string | null;
    display_name?: string;
  }) {
    const response = await fetch("/api/account/profile", {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    const result = (await response.json().catch(() => ({}))) as {
      avatar_url?: string | null;
      display_name?: string;
    };
    if (!response.ok) throw new Error("profile_update_failed");
    return result;
  }

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draftName.trim();
    if (!value || value === displayName) {
      closeNameEditor();
      return;
    }
    setBusy("name");
    try {
      const result = await updateProfile({ display_name: value });
      const savedName = result.display_name ?? value;
      setDisplayName(savedName);
      closeNameEditor(savedName);
      showToast("展示名已保存。");
    } catch {
      showToast("展示名没有保存，请检查后重试。", "error");
    } finally {
      setBusy(null);
    }
  }

  function openAvatarPicker() {
    if (busy !== null) return;
    fileInput.current?.click();
  }

  function closeAvatarEditor() {
    if (busy === "avatar") return;
    setAvatarEditorOpen(false);
    replaceAvatarDraft(null);
    setAvatarError("");
  }

  async function selectAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy("avatar");
    setAvatarError("");
    try {
      const draft = await avatarImageDraft(file);
      replaceAvatarDraft(draft);
      setAvatarEditorOpen(true);
    } catch {
      showToast("图片没有读取，请选择 8 MB 以内的 JPG、PNG 或 WebP 图片。", "error");
    } finally {
      setBusy(null);
    }
  }

  async function saveAvatar(crop: AvatarCrop) {
    if (!avatarDraft) return;
    setBusy("avatar");
    setAvatarError("");
    try {
      const dataUrl = await avatarDataUrl(avatarDraft, crop);
      const result = await updateProfile({ avatar_url: dataUrl });
      setAvatarUrl(result.avatar_url ?? dataUrl);
      setAvatarEditorOpen(false);
      replaceAvatarDraft(null);
      showToast("头像已保存。");
    } catch {
      setAvatarError("头像没有保存，请检查网络后重试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="account-profile__identity">
      <button
        aria-label={busy === "avatar" ? "正在处理头像" : "更换头像"}
        className="account-profile__avatar account-profile__avatar-button"
        disabled={busy !== null}
        onClick={openAvatarPicker}
        ref={avatarButton}
        type="button"
      >
        {avatarUrl ? <img alt="" src={avatarUrl} /> : avatarInitial}
        <span aria-hidden="true" className="account-profile__avatar-edit">
          {busy === "avatar" ? "…" : "更换"}
        </span>
        <i />
      </button>
      <input
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={(event) => void selectAvatar(event)}
        ref={fileInput}
        type="file"
      />

      <div className="account-profile__copy" ref={profileCopyRef}>
        {editingName ? (
          <form
            className="profile-name-editor"
            onSubmit={saveName}
            style={
              editorWidth === null
                ? undefined
                : { width: `${Math.ceil(editorWidth)}px` }
            }
          >
            <label className="sr-only" htmlFor="quick-display-name">
              展示名
            </label>
            <span
              aria-hidden="true"
              className="profile-name-editor__measure"
              ref={nameMeasureRef}
            >
              {draftName || " "}
            </span>
            <span className="profile-name-editor__field">
              <span aria-hidden="true" className="profile-name-editor__mirror">
                {draftName || "\u200b"}
              </span>
              <textarea
                autoFocus
                disabled={busy !== null}
                id="quick-display-name"
                maxLength={50}
                onChange={(event) =>
                  setDraftName(event.target.value.replace(/[\r\n]+/g, " "))
                }
                onCompositionEnd={() => {
                  nameCompositionActiveRef.current = false;
                }}
                onCompositionStart={() => {
                  nameCompositionActiveRef.current = true;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    closeNameEditor();
                    return;
                  }
                  if (
                    shouldSubmitProfileNameEnter({
                      compositionActive: nameCompositionActiveRef.current,
                      key: event.key,
                      keyCode: event.nativeEvent.keyCode,
                      nativeIsComposing: event.nativeEvent.isComposing,
                    })
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                required
                rows={1}
                value={draftName}
              />
            </span>
            <span
              className="profile-name-editor__actions"
              ref={nameActionsRef}
            >
              <button disabled={busy !== null} type="submit">
                {busy === "name" ? "保存中" : "保存"}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => closeNameEditor()}
                type="button"
              >
                取消
              </button>
            </span>
          </form>
        ) : (
          <h1>
            <button
              aria-label={`修改展示名，当前为 ${displayName}`}
              className="profile-name-trigger"
              disabled={busy !== null}
              onClick={() => {
                const initialWidth =
                  nameButton.current?.getBoundingClientRect().width ?? null;
                initialNameEditorWidthRef.current = initialWidth ?? 0;
                setEditorWidth(initialWidth);
                setEditingName(true);
              }}
              ref={nameButton}
              type="button"
            >
              <span>{displayName}</span>
              <small aria-hidden="true">编辑</small>
            </button>
          </h1>
        )}
        {attentionId ? (
          <p className="account-profile__attention-id">@{attentionId}</p>
        ) : null}
        <div aria-label="账号身份" className="account-profile__badges">
          <span>{isMember ? "Member" : "Free"}</span>
          {isFilter ? <span>Filter</span> : null}
        </div>
      </div>

      <TransientFeedback feedback={feedback} />

      {avatarEditorOpen && avatarDraft ? (
        <ProfileAvatarModal
          busy={busy === "avatar"}
          displayName={displayName}
          draft={avatarDraft}
          error={avatarError}
          key={avatarDraft.src}
          onChooseImage={openAvatarPicker}
          onClose={closeAvatarEditor}
          onSave={(crop) => void saveAvatar(crop)}
          returnFocusRef={avatarButton}
        />
      ) : null}
    </div>
  );
}

function ProfileAvatarModal({
  busy,
  displayName,
  draft,
  error,
  onChooseImage,
  onClose,
  onSave,
  returnFocusRef,
}: {
  busy: boolean;
  displayName: string;
  draft: AvatarImageDraft;
  error: string;
  onChooseImage: () => void;
  onClose: () => void;
  onSave: (crop: AvatarCrop) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<CropOffset>({ x: 0, y: 0 });
  const modalRef = useRef<HTMLDivElement>(null);
  const cropRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dismissibleRef = useRef(!busy);
  const onCloseRef = useRef(onClose);
  const dragRef = useRef<{
    originX: number;
    originY: number;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);

  useEffect(() => {
    dismissibleRef.current = !busy;
  }, [busy]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!dismissibleRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      (returnFocusRef.current ?? previousActiveElement)?.focus();
    };
  }, [returnFocusRef]);

  function viewportSize() {
    return cropRef.current?.getBoundingClientRect().width || DEFAULT_PREVIEW_SIZE;
  }

  function clampOffset(x: number, y: number, nextZoom = zoom): CropOffset {
    const size = viewportSize();
    const sourceSize = Math.min(draft.naturalWidth, draft.naturalHeight);
    const renderedWidth = (draft.naturalWidth / sourceSize) * size * nextZoom;
    const renderedHeight = (draft.naturalHeight / sourceSize) * size * nextZoom;
    return {
      x: Math.max(-Math.max(0, (renderedWidth - size) / 2), Math.min(Math.max(0, (renderedWidth - size) / 2), x)),
      y: Math.max(-Math.max(0, (renderedHeight - size) / 2), Math.min(Math.max(0, (renderedHeight - size) / 2), y)),
    };
  }

  function updateZoom(nextZoom: number) {
    const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    setZoom(clampedZoom);
    setOffset((current) => clampOffset(current.x, current.y, clampedZoom));
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (busy) return;
    dragRef.current = {
      originX: offset.x,
      originY: offset.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || busy || drag.pointerId !== event.pointerId) return;
    setOffset(
      clampOffset(
        drag.originX + event.clientX - drag.startX,
        drag.originY + event.clientY - drag.startY,
      ),
    );
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }

  function onWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (busy) return;
    event.preventDefault();
    updateZoom(zoom + (event.deltaY > 0 ? -0.08 : 0.08));
  }

  const sourceSize = Math.min(draft.naturalWidth, draft.naturalHeight);
  const imageWidth = (draft.naturalWidth / sourceSize) * 100;
  const imageHeight = (draft.naturalHeight / sourceSize) * 100;

  return (
    <div
      aria-labelledby="profile-avatar-modal-title"
      aria-modal="true"
      className="profile-avatar-modal"
      ref={modalRef}
      role="dialog"
    >
      <button
        aria-label="关闭头像编辑窗口"
        className="profile-avatar-modal__backdrop"
        data-modal-backdrop=""
        disabled={busy}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <section className="profile-avatar-modal__sheet">
        <header className="profile-avatar-modal__heading">
          <div>
            <p className="eyebrow">公开身份</p>
            <h2 id="profile-avatar-modal-title">编辑头像</h2>
          </div>
          <button
            aria-label="关闭"
            className="profile-avatar-modal__close"
            disabled={busy}
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </header>

        <p className="profile-avatar-modal__description">
          拖动图片调整位置，使用滑杆或滚轮调整大小。
        </p>

        <div
          aria-label="头像裁剪区域"
          className="profile-avatar-modal__crop"
          onPointerCancel={onPointerUp}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          ref={cropRef}
          role="region"
          tabIndex={0}
        >
          <img
            alt={`${displayName}的头像裁剪预览`}
            draggable={false}
            src={draft.src}
            style={{
              height: `${imageHeight}%`,
              left: `calc(50% + ${offset.x}px)`,
              top: `calc(50% + ${offset.y}px)`,
              transform: `translate(-50%, -50%) scale(${zoom})`,
              width: `${imageWidth}%`,
            }}
          />
          <span aria-hidden="true" className="profile-avatar-modal__crop-ring" />
        </div>

        <div className="profile-avatar-modal__zoom-label">
          <span>缩放</span>
          <strong>{Math.round(zoom * 100)}%</strong>
        </div>
        <div className="profile-avatar-modal__zoom">
          <button
            aria-label="缩小头像"
            disabled={busy || zoom <= MIN_ZOOM}
            onClick={() => updateZoom(zoom - 0.1)}
            type="button"
          >
            −
          </button>
          <input
            aria-label="缩放头像"
            disabled={busy}
            max={MAX_ZOOM}
            min={MIN_ZOOM}
            onChange={(event) => updateZoom(Number(event.target.value))}
            step="0.01"
            type="range"
            value={zoom}
          />
          <button
            aria-label="放大头像"
            disabled={busy || zoom >= MAX_ZOOM}
            onClick={() => updateZoom(zoom + 0.1)}
            type="button"
          >
            +
          </button>
        </div>

        <button
          className="button button--secondary profile-avatar-modal__choose"
          disabled={busy}
          onClick={onChooseImage}
          type="button"
        >
          换一张图片
        </button>
        <p className="profile-avatar-modal__hint">支持 JPG、PNG 或 WebP，文件不超过 8 MB。</p>
        {error ? (
          <p aria-live="assertive" className="profile-avatar-modal__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="profile-avatar-modal__actions">
          <button
            className="button button--secondary"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className="button button--primary"
            disabled={busy}
            onClick={() =>
              onSave({
                offsetX: offset.x,
                offsetY: offset.y,
                previewSize: viewportSize(),
                zoom,
              })
            }
            type="button"
          >
            {busy ? "保存中…" : "保存头像"}
          </button>
        </div>
      </section>
    </div>
  );
}
