import type { OAuthAudience, OAuthScope } from "@attention/auth";

export interface OAuthPermissionGroup {
  id: string;
  title: string;
  description: string;
  risk: "standard" | "write" | "irreversible";
}

export interface OAuthConsentPresentation {
  audienceSummary: string;
  dataItems: string[];
  permissionGroups: OAuthPermissionGroup[];
}

export class OAuthConsentPresentationError extends Error {
  constructor() {
    super("unmapped_oauth_scope");
    this.name = "OAuthConsentPresentationError";
  }
}

interface PermissionDescriptor {
  scopes: readonly OAuthScope[];
  present: (requested: ReadonlySet<OAuthScope>) => OAuthPermissionGroup;
}

const mcpDescriptors: readonly PermissionDescriptor[] = [
  {
    scopes: ["profile:read", "subscription:read", "collection:read"],
    present: (requested) => {
      const parts = [
        requested.has("profile:read") ? "公开资料" : null,
        requested.has("subscription:read") ? "会员与订阅状态" : null,
        requested.has("collection:read") ? "私人收藏" : null,
      ].filter((part): part is string => part !== null);
      return {
        id: "account-and-collections",
        title: "查看账号与私人收藏",
        description: `查看你的${parts.join("、")}。`,
        risk: "standard",
      };
    },
  },
  {
    scopes: ["collection:write"],
    present: () => ({
      id: "add-collections",
      title: "新增私人收藏",
      description: "为你新增私人收藏，但不能编辑或删除已有收藏。",
      risk: "write",
    }),
  },
  {
    scopes: ["digest:read", "digest:write"],
    present: (requested) => {
      const canRead = requested.has("digest:read");
      const canWrite = requested.has("digest:write");
      return {
        id: "digest-settings",
        title: "查看和修改日报",
        description:
          canRead && canWrite
            ? "查看并修改你的日报订阅和发送时间设置。"
            : canWrite
              ? "修改你的日报订阅和发送时间设置。"
              : "查看你的日报订阅和发送时间设置。",
        risk: canWrite ? "write" : "standard",
      };
    },
  },
  {
    scopes: ["public:read", "public:full", "ai:search"],
    present: (requested) => ({
      id: "public-and-ai-search",
      title: "使用公开内容与 AI 检索",
      description: requested.has("ai:search")
        ? "读取你当前权限可访问的公开内容，并使用 Attention 的 AI 检索。"
        : "读取你当前权限可访问的公开内容；会员能力仍会在每次访问时检查。",
      risk: "standard",
    }),
  },
  {
    scopes: [
      "moderation:write",
      "moderation:court:read",
      "moderation:court:vote",
    ],
    present: (requested) => {
      const canReport = requested.has("moderation:write");
      const canReadCourt = requested.has("moderation:court:read");
      const canVote = requested.has("moderation:court:vote");
      const actions = [
        canReport ? "举报公开内容" : null,
        canReadCourt ? "查看当前治理案件" : null,
        canVote ? "经你逐次确认后提交不可更改的治理投票" : null,
      ].filter((part): part is string => part !== null);
      return {
        id: "public-governance",
        title: "参与公开治理",
        description: `${actions.join("、")}。`,
        risk: canVote ? "irreversible" : canReport ? "write" : "standard",
      };
    },
  },
] as const;

const syncDescriptors: readonly PermissionDescriptor[] = [
  {
    scopes: ["sync:read", "sync:write"],
    present: (requested) => {
      const canRead = requested.has("sync:read");
      const canWrite = requested.has("sync:write");
      return {
        id: "sync-collections",
        title: "同步你的私人收藏",
        description:
          canRead && canWrite
            ? "下载并上传你的私人收藏变更。"
            : canWrite
              ? "上传你的私人收藏变更。"
              : "下载你的私人收藏变更。",
        risk: canWrite ? "write" : "standard",
      };
    },
  },
] as const;

const runtimeDescriptors: readonly PermissionDescriptor[] = [
  {
    scopes: ["runtime:register"],
    present: () => ({
      id: "register-runtime",
      title: "连接本地 Agent",
      description: "把这台受信任设备上的本地 Agent 连接到你的 Attention 账号。",
      risk: "write",
    }),
  },
  {
    scopes: ["runtime:heartbeat"],
    present: () => ({
      id: "runtime-health",
      title: "上报运行状态",
      description: "上报设备和运行环境健康状态、最近活动时间及安全的队列数量。",
      risk: "write",
    }),
  },
  {
    scopes: ["channel:bind:report", "channel:disconnect:report"],
    present: (requested) => {
      const canBind = requested.has("channel:bind:report");
      const canDisconnect = requested.has("channel:disconnect:report");
      return {
        id: "channel-connection-state",
        title: "同步渠道连接状态",
        description:
          canBind && canDisconnect
            ? "上报本地渠道的连接、验证和断开状态。"
            : canBind
              ? "上报本地渠道的连接和验证状态。"
              : "上报本地渠道的断开状态。",
        risk: "write",
      };
    },
  },
] as const;

const descriptors: Readonly<Record<OAuthAudience, readonly PermissionDescriptor[]>> = {
  "attention-mcp": mcpDescriptors,
  "attention-sync": syncDescriptors,
  "attention-channel-runtime": runtimeDescriptors,
};

const audienceSummaries: Readonly<Record<OAuthAudience, string>> = {
  "attention-mcp": "让 Agent 在你允许的范围内使用 Attention。",
  "attention-sync": "让客户端在你允许的方向同步私人收藏。",
  "attention-channel-runtime": "让这台设备上的本地 Agent 安全连接 Attention。",
};

const dataItemsByScope: Readonly<Record<OAuthScope, readonly string[]>> = {
  "profile:read": ["你的公开资料"],
  "subscription:read": ["你的会员与订阅状态"],
  "collection:read": ["你的私人收藏链接、收藏状态和基础信息"],
  "collection:write": ["你新增的私人收藏链接和基础信息"],
  "digest:read": ["你的日报订阅和发送时间设置"],
  "digest:write": ["你的日报订阅和发送时间设置"],
  "moderation:write": ["你提交的公开内容举报记录"],
  "moderation:court:read": ["公开治理案件记录"],
  "moderation:court:vote": ["你提交的治理投票记录"],
  "public:read": ["你当前权限可访问的公开内容结果"],
  "public:full": ["你当前权限可访问的公开内容结果"],
  "ai:search": ["你的 AI 检索请求和返回的公开内容结果"],
  "sync:read": ["你的私人收藏链接、收藏状态和同步元数据"],
  "sync:write": ["你的私人收藏链接、收藏状态和同步元数据"],
  "runtime:register": ["受信任设备名称和本地 Agent 主机标识"],
  "runtime:heartbeat": ["运行状态、最近活动时间和安全的队列数量"],
  "channel:bind:report": ["不透明的渠道连接验证状态"],
  "channel:disconnect:report": ["不透明的渠道连接断开状态"],
};

const runtimeExclusion =
  "不会接触对话内容、私人收藏、服务商凭据或本地 Session";

export function buildOAuthConsentPresentation(
  audience: OAuthAudience,
  scopes: readonly OAuthScope[],
): OAuthConsentPresentation {
  const requested = new Set(scopes);
  const covered = new Set<OAuthScope>();
  const permissionGroups = descriptors[audience].flatMap((descriptor) => {
    const matching = descriptor.scopes.filter((scope) => requested.has(scope));
    if (matching.length === 0) return [];
    matching.forEach((scope) => covered.add(scope));
    return [descriptor.present(requested)];
  });

  if (
    permissionGroups.length === 0 ||
    covered.size !== requested.size ||
    scopes.some((scope) => !covered.has(scope))
  ) {
    throw new OAuthConsentPresentationError();
  }

  const dataItems = [
    ...new Set(scopes.flatMap((scope) => dataItemsByScope[scope] ?? [])),
  ];
  if (audience === "attention-channel-runtime") dataItems.push(runtimeExclusion);

  return {
    audienceSummary: audienceSummaries[audience],
    dataItems,
    permissionGroups,
  };
}
