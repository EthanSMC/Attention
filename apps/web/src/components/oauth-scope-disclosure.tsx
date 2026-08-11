const scopeLabels: Record<string, string> = {
  "ai:search": "使用托管 AI 检索（需要实时 Member 权益）",
  "channel:bind:report": "报告本地渠道绑定与验证结果",
  "channel:disconnect:report": "报告本地渠道断开与凭证删除结果",
  "collection:read": "读取你的个人收藏",
  "collection:write": "替你新增私人收藏",
  "digest:read": "读取你的日报订阅与发送时间",
  "digest:write": "修改你的日报订阅与发送时间",
  "moderation:write": "按你的要求举报公开内容",
  "moderation:court:read": "读取 Filter 小法庭的当前案件与票数",
  "moderation:court:vote": "在你逐次明确确认后提交不可更改的小法庭投票",
  "profile:read": "读取你的公开资料和会员状态",
  "public:full": "读取完整公开流（需要实时 Member 权益）",
  "public:read": "读取当前可见的公开内容",
  "runtime:heartbeat": "上报本地 Runtime 与渠道健康状态",
  "runtime:register": "注册当前本地 Agent 安装",
  "subscription:read": "读取订阅状态",
  "sync:read": "下载你的同步变更",
  "sync:write": "上传你的同步变更",
};

const scopeCategories = [
  {
    id: "content",
    matches: (scope: string) =>
      scope.startsWith("collection:") ||
      scope.startsWith("public:") ||
      scope.startsWith("sync:"),
    title: "收藏与公开内容",
  },
  {
    id: "intelligence",
    matches: (scope: string) =>
      scope.startsWith("ai:") ||
      scope.startsWith("digest:") ||
      scope.startsWith("subscription:"),
    title: "AI 与日报",
  },
  {
    id: "community",
    matches: (scope: string) => scope.startsWith("moderation:"),
    title: "社区治理",
  },
  {
    id: "account",
    matches: (scope: string) =>
      scope.startsWith("profile:") ||
      scope.startsWith("runtime:") ||
      scope.startsWith("channel:"),
    title: "账号",
  },
] as const;

export interface OAuthScopeGroup {
  id: string;
  scopes: Array<{ description: string; id: string }>;
  title: string;
}

export function groupOAuthScopes(scopes: readonly string[]): OAuthScopeGroup[] {
  const groups: OAuthScopeGroup[] = scopeCategories.map((category) => ({
    id: category.id,
    scopes: scopes
      .filter(category.matches)
      .map((scope) => ({
        description: scopeLabels[scope] ?? scope,
        id: scope,
      })),
    title: category.title,
  }));
  const matched = new Set(groups.flatMap((group) => group.scopes.map((scope) => scope.id)));
  const other = scopes
    .filter((scope) => !matched.has(scope))
    .map((scope) => ({ description: scopeLabels[scope] ?? scope, id: scope }));
  if (other.length > 0) groups.push({ id: "other", scopes: other, title: "其他" });
  return groups.filter((group) => group.scopes.length > 0);
}

export function OAuthScopeDisclosure({ scopes }: { scopes: readonly string[] }) {
  return (
    <div className="oauth-scope-groups">
      {groupOAuthScopes(scopes).map((group) => (
        <section className="oauth-scope-group" key={group.id}>
          <h3>{group.title}</h3>
          <ul>
            {group.scopes.map((scope) => (
              <li key={scope.id}>
                <span>{scope.description}</span>
                <code>{scope.id}</code>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
