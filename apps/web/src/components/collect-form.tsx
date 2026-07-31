"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type {
  AmbiguousCollectResult,
  CollectAdapter,
  CollectResult,
  Visibility,
} from "../lib/attention";
import {
  AttentionHttpError,
  httpCollectAdapter,
} from "../lib/http-attention";
import {
  ArrowUpRightIcon,
  CheckIcon,
  LinkIcon,
  ShieldIcon,
  WarningIcon,
} from "./icons";
import { VisibilityChoice } from "./signal-elements";

function createIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function requestFailure(error: unknown, fallback: string): string {
  return error instanceof AttentionHttpError ? error.message : fallback;
}

function ProcessingTrack() {
  return (
    <ol aria-label="收藏处理进度" className="processing-track">
      <li className="processing-track__complete">
        <CheckIcon />
        <span>提取</span>
      </li>
      <li className="processing-track__complete">
        <CheckIcon />
        <span>安全确认</span>
      </li>
      <li className="processing-track__complete">
        <CheckIcon />
        <span>已收藏</span>
      </li>
    </ol>
  );
}

function ContentIdentity({
  content,
}: {
  content: { host: string; source: string; sourceInitial: string; title: string };
}) {
  return (
    <div className="receipt-content">
      <span aria-hidden="true" className="receipt-content__source">
        {content.sourceInitial}
      </span>
      <span>
        <strong>{content.title}</strong>
        <small>
          {content.source} · {content.host}
        </small>
      </span>
    </div>
  );
}

function AmbiguousChoices({
  busy,
  onContinue,
  result,
}: {
  busy: boolean;
  onContinue: (result: AmbiguousCollectResult, candidateId: string) => Promise<void>;
  result: AmbiguousCollectResult;
}) {
  const [selectedId, setSelectedId] = useState(
    result.candidates[0]?.candidateId ?? "",
  );

  return (
    <fieldset className="candidate-list">
      <legend>选择要收藏的一个内容</legend>
      {result.candidates.map((candidate) => (
        <label key={candidate.candidateId}>
          <input
            checked={selectedId === candidate.candidateId}
            name="content-candidate"
            onChange={() => setSelectedId(candidate.candidateId)}
            type="radio"
            value={candidate.candidateId}
          />
          <span className="candidate-list__radio" aria-hidden="true" />
          <span>
            <strong>{candidate.title}</strong>
            <small>
              {candidate.source} · {candidate.host}
            </small>
          </span>
        </label>
      ))}
      <button
        className="button button--primary button--compact"
        disabled={!selectedId || busy}
        onClick={() => void onContinue(result, selectedId)}
        type="button"
      >
        {busy ? "正在收藏…" : "收藏所选内容"}
      </button>
    </fieldset>
  );
}

function CollectReceipt({
  allowPublic,
  busy,
  failure,
  onContinue,
  onRetry,
  onSelectCandidate,
  onVisibilityChange,
  result,
}: {
  allowPublic: boolean;
  busy: boolean;
  failure: string | null;
  onContinue: () => void;
  onRetry: () => Promise<void>;
  onSelectCandidate: (
    result: AmbiguousCollectResult,
    candidateId: string,
  ) => Promise<void>;
  onVisibilityChange: (visibility: Visibility) => Promise<void>;
  result: CollectResult | null;
}) {
  if (failure) {
    return (
      <section aria-labelledby="receipt-title" className="receipt receipt--danger" role="alert">
        <div className="receipt__heading">
          <WarningIcon />
          <div>
            <p className="receipt__eyebrow">没有完成</p>
            <h2 id="receipt-title">暂时无法连接收藏服务</h2>
          </div>
        </div>
        <p>{failure}</p>
        <button className="button button--secondary button--compact" disabled={busy} onClick={() => void onRetry()} type="button">
          {busy ? "正在重试…" : "重试"}
        </button>
      </section>
    );
  }

  if (!result) return null;

  if (result.status === "accepted" || result.status === "merged_with_existing_content") {
    const isPublic = result.visibility === "public";
    return (
      <section aria-labelledby="receipt-title" className="receipt receipt--success" role="status">
        <div className="receipt__heading">
          <CheckIcon />
          <div>
            <p className="receipt__eyebrow">收藏成功</p>
            <h2 id="receipt-title">{isPublic ? "已公开收藏" : "已保存到我的收藏"}</h2>
          </div>
        </div>
        {result.status === "merged_with_existing_content" ? (
          <p className="receipt__note">已关联到 Attention 中的已有内容；这是你自己的收藏记录。</p>
        ) : null}
        <ContentIdentity content={result.content} />
        <ProcessingTrack />
        <p className="receipt__note">
          链接已经保存。标题或摘要若能生成，会在“我的收藏”更新；没有摘要也不影响收藏记录。
        </p>
        <div className="receipt__actions">
          {isPublic || allowPublic ? (
            <button
              className="button button--secondary button--compact"
              disabled={busy}
              onClick={() => void onVisibilityChange(isPublic ? "private" : "public")}
              type="button"
            >
              {busy ? "正在保存…" : isPublic ? "改为私密" : "重新公开"}
            </button>
          ) : null}
          <Link className="text-link" href="/mine">
            查看我的收藏
            <ArrowUpRightIcon />
          </Link>
          <button className="text-button" onClick={onContinue} type="button">
            继续收藏
          </button>
        </div>
      </section>
    );
  }

  if (result.status === "already_collected") {
    const isPublic = result.visibility === "public";
    return (
      <section aria-labelledby="receipt-title" className="receipt receipt--neutral" role="status">
        <div className="receipt__heading">
          <CheckIcon />
          <div>
            <p className="receipt__eyebrow">没有创建重复收藏</p>
            <h2 id="receipt-title">已经{isPublic ? "公开" : "私密"}收藏过</h2>
          </div>
        </div>
        <ContentIdentity content={result.content} />
        <p className="receipt__note">本次提交没有更改原来的公开状态。</p>
        <div className="receipt__actions">
          {isPublic || allowPublic ? (
            <button
              className="button button--secondary button--compact"
              disabled={busy}
              onClick={() => void onVisibilityChange(isPublic ? "private" : "public")}
              type="button"
            >
              {busy ? "正在保存…" : isPublic ? "改为私密" : "重新公开"}
            </button>
          ) : null}
          <Link className="text-link" href="/mine">
            查看我的收藏
            <ArrowUpRightIcon />
          </Link>
        </div>
      </section>
    );
  }

  if (result.status === "ambiguous") {
    return (
      <section aria-labelledby="receipt-title" className="receipt receipt--warning" role="status">
        <div className="receipt__heading">
          <WarningIcon />
          <div>
            <p className="receipt__eyebrow">需要选择</p>
            <h2 id="receipt-title">发现 {result.candidates.length} 个内容链接</h2>
          </div>
        </div>
        <p>先选一个真实内容目标。现在尚未创建收藏，也没有公开任何内容。</p>
        <AmbiguousChoices busy={busy} onContinue={onSelectCandidate} result={result} />
      </section>
    );
  }

  if (result.status === "resolution_pending") {
    return (
      <section aria-labelledby="receipt-title" className="receipt receipt--warning" role="status">
        <div className="receipt__heading">
          <ShieldIcon />
          <div>
            <p className="receipt__eyebrow">安全确认中</p>
            <h2 id="receipt-title">正在确认短链接目标</h2>
          </div>
        </div>
        <p>
          {result.host} 的最终目标暂时无法确定。目前尚未收藏或公开；你可以稍后重新检查，
          Attention 仍会先完成安全确认。
        </p>
        <button className="button button--secondary button--compact" disabled={busy} onClick={() => void onRetry()} type="button">
          {busy ? "正在检查…" : "重新检查"}
        </button>
      </section>
    );
  }

  if (result.status === "unsafe") {
    return (
      <section aria-labelledby="receipt-title" className="receipt receipt--danger" role="alert">
        <div className="receipt__heading">
          <ShieldIcon />
          <div>
            <p className="receipt__eyebrow">安全阻断</p>
            <h2 id="receipt-title">未保存这个链接</h2>
          </div>
        </div>
        <p>{result.reason}</p>
        <p className="receipt__note">为保护凭证，Attention 不会在此回显完整地址。</p>
      </section>
    );
  }

  if (result.status === "invalid") {
    return (
      <section aria-labelledby="receipt-title" className="receipt receipt--danger" role="alert">
        <div className="receipt__heading">
          <LinkIcon />
          <div>
            <p className="receipt__eyebrow">无法识别</p>
            <h2 id="receipt-title">没有找到有效内容链接</h2>
          </div>
        </div>
        <p>{result.reason}</p>
        <p className="receipt__note">可粘贴 HTTP(S) 原始链接，或包含一个链接的完整平台分享文案。</p>
      </section>
    );
  }

  return null;
}

export function CollectForm({
  allowPublic = true,
  adapter = httpCollectAdapter,
  initialVisibility = "public",
}: {
  allowPublic?: boolean;
  adapter?: CollectAdapter;
  initialVisibility?: Visibility;
}) {
  const [rawInput, setRawInput] = useState("");
  const [visibility, setVisibility] = useState<Visibility>(
    allowPublic ? initialVisibility : "private",
  );
  const [result, setResult] = useState<CollectResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef("");
  const receipt = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (result || failure) {
      receipt.current?.scrollIntoView({ block: "nearest" });
      receipt.current?.focus({ preventScroll: true });
    }
  }, [failure, result]);

  async function submit() {
    if (!rawInput.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    setResult(null);
    idempotencyKey.current ||= createIdempotencyKey();

    try {
      const nextResult = await adapter.submit({
        rawInput,
        visibility,
        idempotencyKey: idempotencyKey.current,
      });
      setResult(nextResult);
    } catch (error) {
      setFailure(
        requestFailure(
          error,
          "输入仍保留在当前页面。请检查网络后重试；重试不会创建重复收藏。",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (result?.status === "resolution_pending") {
      idempotencyKey.current = "";
    }
    await submit();
  }

  async function selectCandidate(
    ambiguousResult: AmbiguousCollectResult,
    candidateId: string,
  ) {
    if (busy) return;
    setBusy(true);
    try {
      const nextResult = await adapter.selectCandidate({
        selectionToken: ambiguousResult.selectionToken,
        candidateId,
        visibility,
      });
      setResult(nextResult);
    } catch (error) {
      if (error instanceof AttentionHttpError && error.status === 409) {
        idempotencyKey.current = "";
      }
      setFailure(
        requestFailure(error, "候选选择没有完成，请重试。尚未创建收藏。"),
      );
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  async function updateVisibility(nextVisibility: Visibility) {
    if (!result || !("content" in result) || busy) return;
    setBusy(true);
    try {
      const savedVisibility = await adapter.updateVisibility({
        collectionId: result.content.id,
        visibility: nextVisibility,
      });
      setVisibility(savedVisibility);
      setResult((current) => {
        if (!current || !("content" in current)) return current;
        return { ...current, visibility: savedVisibility };
      });
    } catch (error) {
      setFailure(
        requestFailure(error, "公开设置没有保存，请重试。原来的状态保持不变。"),
      );
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  function changeInput(value: string) {
    setRawInput(value);
    idempotencyKey.current = "";
    if (result || failure) {
      setResult(null);
      setFailure(null);
    }
  }

  function reset() {
    setRawInput("");
    setResult(null);
    setFailure(null);
    idempotencyKey.current = "";
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#collect-input")?.focus());
  }

  return (
    <div className="collect-workbench">
      <form
        aria-busy={busy}
        className="collect-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field-group">
          <label htmlFor="collect-input">链接或完整分享文案</label>
          <textarea
            aria-describedby="collect-input-help collect-input-privacy"
            autoComplete="off"
            data-1p-ignore="true"
            id="collect-input"
            name="shared-content"
            onChange={(event) => changeInput(event.target.value)}
            placeholder="例如：复制的小红书分享文案、抖音短链接或网页地址"
            required
            rows={7}
            value={rawInput}
          />
          <div className="field-help" id="collect-input-help">
            <span>支持抖音、小红书、微信公众号和普通网页</span>
            <span id="collect-input-privacy">整段分享文案仅用于本次解析，不会作为收藏内容长期保存</span>
          </div>
        </div>

        <fieldset className="visibility-fieldset">
          <legend>收藏到</legend>
          <div className="visibility-options">
            {allowPublic ? (
              <VisibilityChoice
                description="出现在 AI 公开流，并可进入未来的公共 Email 与 MCP 检索。"
                id="visibility-public"
                name="visibility"
                onChange={setVisibility}
                value="public"
                visibility={visibility}
              />
            ) : null}
            <VisibilityChoice
              description="只在我的收藏中出现，不进入公共标签和统计。"
              id="visibility-private"
              name="visibility"
              onChange={setVisibility}
              value="private"
              visibility={visibility}
            />
          </div>
          {!allowPublic ? (
            <p className="field-help">只有受邀 Filter 可以公开收藏；会员收藏默认私密。</p>
          ) : null}
          {visibility === "public" ? (
            <p className="public-boundary" role="note">
              <GlobeNotice />
              <span>
                公开后仍可改为私密，这会停止未来的网站、Email 和公共 MCP 曝光；已经发送的 Email 无法召回。
              </span>
            </p>
          ) : null}
        </fieldset>

        <button className="button button--primary collect-submit" disabled={busy || !rawInput.trim()} type="submit">
          {busy ? "正在识别和安全确认…" : visibility === "public" ? "公开收藏" : "私密收藏"}
        </button>
      </form>

      <div
        aria-label={result || failure ? "收藏结果" : undefined}
        className="receipt-focus"
        ref={receipt}
        role={result || failure ? "region" : undefined}
        tabIndex={-1}
      >
        <CollectReceipt
          allowPublic={allowPublic}
          busy={busy}
          failure={failure}
          onContinue={reset}
          onRetry={retry}
          onSelectCandidate={selectCandidate}
          onVisibilityChange={updateVisibility}
          result={result}
        />
      </div>

    </div>
  );
}

function GlobeNotice() {
  return (
    <span aria-hidden="true" className="public-boundary__icon">
      <span />
      <span />
    </span>
  );
}
