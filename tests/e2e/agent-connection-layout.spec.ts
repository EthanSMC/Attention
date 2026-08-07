import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const stylesheetUrl = new URL(
  "../../apps/web/src/app/globals.css",
  import.meta.url,
);

const agents = ["OpenClaw", "Hermes", "Codex", "Claude Code", "WorkBuddy"];

function fixture(): string {
  return `
    <div class="settings-shell__content">
      <section class="connection-card connection-card--agents">
        <div class="agent-setup-intro"><h2>选择你正在使用的 Agent</h2></div>
        <div class="agent-setup-layout">
          <div class="agent-setup-picker" role="group">
            ${agents
              .map(
                (agent, index) => `
                  <button class="agent-setup-picker__item" aria-pressed="${index === 0}">
                    <span class="agent-setup-picker__mark">${agent[0]}</span>
                    <span class="agent-setup-picker__copy"><strong>${agent}</strong><small>可配置</small></span>
                  </button>
                `,
              )
              .join("")}
          </div>
          <div class="agent-setup-detail">
            <div class="agent-setup-detail__heading">
              <h3>WorkBuddy</h3>
              <div class="agent-status-group"><span class="agent-status-badge agent-status-badge--external">需在宿主界面配置</span><span class="agent-minimum-version">最低版本 4.8.2</span></div>
            </div>
            <div class="agent-setup-path"><span>OpenClaw</span><span aria-hidden="true">→</span><span>Attention MCP</span></div>
            <div class="agent-resource-list">
              <div class="agent-resource-row agent-resource-row--digest"><div><span>SHA-256</span><code>9381996e45d92f8d6acc8bf69c1f4bfd4577432ac53a06fb69aa877e1a969861</code></div><button>复制</button></div>
            </div>
            <div class="agent-manual-checklist">
              <div class="agent-section-heading"><h4>WorkBuddy 安装步骤</h4><span>按顺序完成</span></div>
              <ol>
                <li><div><strong>下载 Skill ZIP</strong><p>下载官方文件。</p></div><button>复制</button></li>
                <li><div><strong>核对 SHA-256</strong><p>核对完整摘要。</p></div><button>复制</button></li>
                <li><div><strong>上传 Skill</strong><p>Add Skill → Upload Skill</p></div></li>
                <li><div><strong>添加 MCP 并授权</strong><p>完成 OAuth。</p></div><button>复制</button></li>
              </ol>
            </div>
            <div class="agent-acceptance-step"><div><span>最终验收</span><strong>在 Agent 中调用</strong><code>attention_get_my_account</code></div><p>只有成功返回才可用。</p></div>
          </div>
        </div>
      </section>
    </div>
  `;
}

test("uses a desktop rail and a single horizontally scrollable mobile chip row", async ({
  page,
}) => {
  const stylesheet = await readFile(stylesheetUrl, "utf8");
  await page.setViewportSize({ height: 900, width: 900 });
  await page.setContent(`<style>${stylesheet}</style>${fixture()}`);

  const desktop = await page.evaluate(() => {
    const layout = document.querySelector<HTMLElement>(".agent-setup-layout");
    const picker = document.querySelector<HTMLElement>(".agent-setup-picker");
    if (!layout || !picker) throw new Error("Agent setup fixture is missing");
    return {
      columns: getComputedStyle(layout).gridTemplateColumns,
      pickerDisplay: getComputedStyle(picker).display,
    };
  });
  expect(desktop.columns.split(" ")).toHaveLength(2);
  expect(desktop.pickerDisplay).toBe("grid");

  await page.setViewportSize({ height: 900, width: 375 });
  const mobile = await page.evaluate(() => {
    const picker = document.querySelector<HTMLElement>(".agent-setup-picker");
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>(".agent-setup-picker__item"),
    );
    if (!picker || buttons.length !== 5) {
      throw new Error("All five Agent chips must be rendered");
    }
    return {
      checklistCounters: Array.from(
        document.querySelectorAll<HTMLElement>(".agent-manual-checklist li"),
        (item) => getComputedStyle(item).counterIncrement,
      ),
      detailFits: (() => {
        const detail = document.querySelector<HTMLElement>(".agent-setup-detail");
        return detail ? detail.scrollWidth <= detail.clientWidth : false;
      })(),
      display: getComputedStyle(picker).display,
      isScrollable: picker.scrollWidth > picker.clientWidth,
      topPositions: buttons.map((button) => button.getBoundingClientRect().top),
    };
  });

  expect(mobile.display).toBe("flex");
  expect(mobile.checklistCounters).toHaveLength(4);
  expect(
    mobile.checklistCounters.every((value) => value.includes("workbuddy-step")),
  ).toBe(true);
  expect(mobile.isScrollable).toBe(true);
  expect(mobile.detailFits).toBe(true);
  expect(new Set(mobile.topPositions).size).toBe(1);
});
