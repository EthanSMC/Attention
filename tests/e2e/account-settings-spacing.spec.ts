import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const stylesheetUrl = new URL(
  "../../apps/web/src/app/globals.css",
  import.meta.url,
);

test("keeps profile field content clear of the next divider at every layout breakpoint", async ({
  page,
}) => {
  const stylesheet = await readFile(stylesheetUrl, "utf8");

  for (const width of [1440, 620, 619, 375]) {
    await page.setViewportSize({ height: 900, width });
    await page.setContent(`
      <style>${stylesheet}</style>
      <div class="settings-shell__content">
        <section class="settings-card account-profile-settings">
          <div class="account-profile-settings__intro">
            <p>公开身份</p>
            <h2>个人资料</h2>
          </div>
          <div class="account-profile-settings__section" data-section="display-name">
            <div class="account-profile-settings__copy">
              <h2>展示名</h2>
              <p>修改个人资料和内容署名中显示的名称。</p>
            </div>
            <div style="height: 44px">展示名控件</div>
          </div>
          <div class="account-profile-settings__section" data-section="attention-id">
            <div class="account-profile-settings__copy">
              <h2>Attention ID</h2>
              <p>显示在个人资料中的公开标识。</p>
            </div>
            <div style="height: 44px">Attention ID 控件</div>
          </div>
        </section>
      </div>
    `);

    const gap = await page.evaluate(() => {
      const current = document.querySelector<HTMLElement>(
        '[data-section="display-name"]',
      );
      const next = document.querySelector<HTMLElement>(
        '[data-section="attention-id"]',
      );
      if (!current || !next) throw new Error("Profile sections are missing");
      const contentBottom = Math.max(
        ...Array.from(current.children, (child) =>
          child.getBoundingClientRect().bottom,
        ),
      );
      return next.getBoundingClientRect().top - contentBottom;
    });

    expect(gap, `viewport width ${width}`).toBeGreaterThanOrEqual(20);
  }
});
