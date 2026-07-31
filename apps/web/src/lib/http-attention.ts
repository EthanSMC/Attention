import {
  CollectorResponseSchema,
  type CollectorResponse,
  type SourceAdapterId,
} from "@attention/contracts";

import type {
  AcceptedCollectResult,
  AlreadyCollectedResult,
  CollectAdapter,
  CollectInput,
  CollectResult,
  ContentPreview,
  Visibility,
} from "./attention";

const sourcePresentation: Record<
  SourceAdapterId,
  { initial: string; name: string }
> = {
  douyin: { initial: "抖", name: "抖音" },
  generic_web: { initial: "网", name: "网页" },
  wechat_official_article: { initial: "微", name: "微信公众号" },
  xiaohongshu: { initial: "小", name: "小红书" },
};

export class AttentionHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AttentionHttpError";
    this.status = status;
  }
}

function firstHost(rawInput: string): string {
  const match = /https?:\/\/[^\s<>"']+/iu.exec(rawInput)?.[0];
  if (!match) return "等待识别";
  try {
    return new URL(match.replace(/[，。！？；：、,.!?;:）)】\]》>]+$/u, ""))
      .hostname;
  } catch {
    return "等待识别";
  }
}

function previewFor(
  response: Extract<
    CollectorResponse,
    {
      status:
        | "accepted"
        | "already_collected"
        | "merged_with_existing_content";
    }
  >,
  host: string,
): ContentPreview {
  const presentation = sourcePresentation[response.source];
  return {
    host,
    id: response.collection_id,
    source: presentation.name,
    sourceInitial: presentation.initial,
    title: response.display_title ?? `${presentation.name}内容`,
  };
}

function reasonFor(code: string): string {
  const reasons: Record<string, string> = {
    dangerous_query: "链接可能包含访问凭证，请改用公开内容页链接。",
    invalid_url: "链接格式不完整，请复制公开内容页的完整地址。",
    no_content_link: "没有找到可收藏的 HTTP(S) 内容链接。",
    non_content_target: "识别到的是下载页或活动页，不是可收藏的内容页。",
    selection_expired: "候选选择已过期，请重新提交原始分享内容。",
    unsafe_target: "链接目标不在公开网络范围内，因此没有保存。",
  };
  return reasons[code] ?? "这个链接暂时无法安全处理，请换一个公开内容页重试。";
}

function toUiResult(
  response: CollectorResponse,
  context: { host: string; visibility: Visibility },
): CollectResult {
  switch (response.status) {
    case "accepted":
    case "merged_with_existing_content":
      return {
        content: previewFor(response, context.host),
        status: response.status,
        visibility: response.current_visibility,
      };
    case "already_collected":
      return {
        content: previewFor(response, context.host),
        status: response.status,
        visibility: response.current_visibility,
      };
    case "ambiguous":
      return {
        candidates: response.candidates.map((candidate) => {
          const presentation = sourcePresentation[candidate.source];
          return {
            candidateId: candidate.candidate_id,
            host: candidate.display_host,
            id: candidate.candidate_id,
            source: presentation.name,
            sourceInitial: presentation.initial,
            title:
              candidate.display_title ??
              `${presentation.name} · ${candidate.display_host}`,
          };
        }),
        selectionToken: response.selection_token,
        status: "ambiguous",
      };
    case "resolution_pending":
      return { host: context.host, status: "resolution_pending" };
    case "invalid":
      return { reason: reasonFor(response.error_code), status: "invalid" };
    case "unsafe":
      return { reason: reasonFor(response.error_code), status: "unsafe" };
  }
}

async function postCollector(path: string, body: unknown): Promise<CollectorResponse> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      response.status === 401
        ? "请先使用邀请链接登录 Attention。"
        : response.status === 403
          ? "当前账号没有执行这个公开操作的权限。"
          : response.status === 409
            ? path.endsWith("/select")
              ? "候选已失效或已被使用，请重新提交原始分享内容。"
              : "这次重试的内容与原请求不一致，请重新提交。"
            : "收藏服务暂时不可用。";
    throw new AttentionHttpError(response.status, message);
  }

  return CollectorResponseSchema.parse(payload);
}

export const httpCollectAdapter: CollectAdapter = {
  async selectCandidate(
    input,
  ): Promise<AcceptedCollectResult | AlreadyCollectedResult> {
    const response = await postCollector("/api/v1/collection-attempts/select", {
      candidate_id: input.candidateId,
      selection_token: input.selectionToken,
      visibility: input.visibility,
    });
    const result = toUiResult(response, {
      host: "已选择的内容",
      visibility: input.visibility,
    });
    if (
      result.status !== "accepted" &&
      result.status !== "merged_with_existing_content" &&
      result.status !== "already_collected"
    ) {
      throw new AttentionHttpError(422, "所选内容暂时无法完成收藏，请重新提交。");
    }
    return result;
  },

  async submit(input: CollectInput): Promise<CollectResult> {
    const response = await postCollector("/api/v1/collection-attempts", {
      idempotency_key: input.idempotencyKey,
      raw_input: input.rawInput,
      visibility: input.visibility,
    });
    return toUiResult(response, {
      host: firstHost(input.rawInput),
      visibility: input.visibility,
    });
  },

  async updateVisibility(input): Promise<Visibility> {
    const response = await fetch(
      `/api/v1/me/collections/${encodeURIComponent(input.collectionId)}/visibility`,
      {
        body: JSON.stringify({ visibility: input.visibility }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    if (!response.ok) {
      throw new AttentionHttpError(response.status, "公开设置没有保存。");
    }
    const payload = (await response.json()) as { visibility?: unknown };
    if (payload.visibility !== "public" && payload.visibility !== "private") {
      throw new AttentionHttpError(500, "收藏服务返回了无效状态。");
    }
    return payload.visibility;
  },
};
