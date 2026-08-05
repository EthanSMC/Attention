"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const AVATAR_SIZE = 256;

async function imageElement(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function avatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/") || file.size > MAX_INPUT_BYTES) {
    throw new RangeError("invalid_avatar_file");
  }

  const image = await imageElement(file);
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  if (sourceSize < 1) throw new RangeError("invalid_avatar_file");

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    (image.naturalWidth - sourceSize) / 2,
    (image.naturalHeight - sourceSize) / 2,
    sourceSize,
    sourceSize,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
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
  const [editorWidth, setEditorWidth] = useState<number | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [busy, setBusy] = useState<"avatar" | "name" | null>(null);
  const [message, setMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const avatarInitial = Array.from(displayName.trim()).at(0) ?? "A";

  function closeNameEditor(nextName = displayName) {
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
    setMessage("");
    try {
      const result = await updateProfile({ display_name: value });
      const savedName = result.display_name ?? value;
      setDisplayName(savedName);
      closeNameEditor(savedName);
      setMessage("展示名已保存。");
    } catch {
      setMessage("展示名没有保存，请检查后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function selectAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy("avatar");
    setMessage("");
    try {
      const dataUrl = await avatarDataUrl(file);
      const result = await updateProfile({ avatar_url: dataUrl });
      setAvatarUrl(result.avatar_url ?? dataUrl);
      setMessage("头像已保存。");
    } catch {
      setMessage("头像没有保存，请选择 8 MB 以内的图片后重试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="account-profile__identity">
      <button
        aria-label={busy === "avatar" ? "正在保存头像" : "修改头像"}
        className="account-profile__avatar account-profile__avatar-button"
        disabled={busy !== null}
        onClick={() => fileInput.current?.click()}
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

      <div className="account-profile__copy">
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
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    closeNameEditor();
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                required
                rows={1}
                value={draftName}
              />
            </span>
            <span className="profile-name-editor__actions">
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
                setEditorWidth(nameButton.current?.getBoundingClientRect().width ?? null);
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
        <p aria-live="polite" className="profile-edit-message">
          {message}
        </p>
      </div>
    </div>
  );
}
