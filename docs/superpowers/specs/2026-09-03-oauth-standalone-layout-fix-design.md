# OAuth 独立授权页布局修复设计

## 问题

`/oauth/authorize` 已通过 `SiteHeader` 和 `MobileNavigation` 的路径判断隐藏用户站导航，但全局桌面 CSS 仍无条件为根布局 `<main>` 预留主站侧栏宽度。在 1120px 及以上视口，这个偏移是 `216px`，因此授权卡片只相对剩余内容区居中，而不是相对整个浏览器视口居中。全局 `body` 还保留了移动导航的底部空间，尽管 OAuth 页面并不渲染移动导航。

## 方案

保持 OAuth 页面组件、认证流程、授权参数、权限展示和提交行为不变。沿用项目已经使用的 `body:has(...)` 独立页面样式模式：

- 当页面包含 `.oauth-consent-shell` 时，将根布局 `<main>` 的 `margin-left` 清零，并保持至少一屏高度。
- 同一页面状态下将 `body` 的移动导航底部预留清零。
- 保留 `.oauth-consent-shell` 现有的 `max-width: 880px`、响应式内边距和 `margin: 0 auto`；清除父级偏移后，它会自然相对整个 viewport 居中。
- 继续依赖现有路径逻辑隐藏主站 Header、收藏入口和移动导航，不新增任何通往用户站的可发现入口。

不采用根布局路由感知状态或新的 Next 根布局，因为它们会扩大客户端布局和路由结构的改动面，而当前缺陷可由局部、可测试的页面状态规则解决。

## 测试

- 新增 Playwright 几何回归测试，加载真实 `globals.css` 并复现真实根布局结构：`body > main > .oauth-consent-shell`。
- 在 1280、1440、1800px 检查根 `<main>` 左边界为 `0`，授权壳左右外边距相等，页面没有横向溢出。
- 在 390px 检查授权壳适配视口、页面没有横向溢出、底部移动导航预留为 `0`。
- 保留并运行现有 `site-navigation.test.tsx`，确认 OAuth 路径不渲染 SiteHeader、收藏入口或 MobileNavigation。
- 运行类型检查、Lint、完整 Vitest、完整 UI Playwright 和生产构建。

## 范围与发布

只修改 OAuth 独立页面布局 CSS、新增布局回归测试和对应文档；不修改 OAuth 数据流、安全校验或提交逻辑。本任务只在当前 worktree 提交并验证，不推送、不发布、不部署。
