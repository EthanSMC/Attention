import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const stylesheetUrl = new URL(
  "../../apps/web/src/app/globals.css",
  import.meta.url,
);

function fixture(stylesheet: string): string {
  return `
    <style>${stylesheet}</style>
    <main id="main-content">
      <div class="oauth-consent-shell">
        <section class="oauth-consent">
          <div class="oauth-consent__header">
            <h1>Codex 想要访问你的 Attention</h1>
            <p>让 Agent 在你允许的范围内使用 Attention。</p>
          </div>
        </section>
      </div>
    </main>
  `;
}

test("centers standalone OAuth consent against the complete viewport", async ({
  page,
}) => {
  const stylesheet = await readFile(stylesheetUrl, "utf8");
  await page.setContent(fixture(stylesheet));

  for (const width of [1280, 1440, 1800, 390]) {
    await page.setViewportSize({ height: width === 390 ? 844 : 900, width });
    const geometry = await page.evaluate((viewportWidth) => {
      const rootMain = document.querySelector<HTMLElement>("body > main");
      const shell = document.querySelector<HTMLElement>(
        ".oauth-consent-shell",
      );
      if (!rootMain || !shell) {
        throw new Error("OAuth fixture is incomplete");
      }

      const shellRect = shell.getBoundingClientRect();
      return {
        bodyPaddingBottom: getComputedStyle(document.body).paddingBottom,
        pageFits:
          document.documentElement.scrollWidth ===
          document.documentElement.clientWidth,
        rootMainLeft: rootMain.getBoundingClientRect().left,
        shellLeft: shellRect.left,
        shellRight: viewportWidth - shellRect.right,
        shellWidth: shellRect.width,
      };
    }, width);

    expect(geometry.rootMainLeft, `viewport ${width}`).toBe(0);
    expect(
      Math.abs(geometry.shellLeft - geometry.shellRight),
      `viewport ${width}`,
    ).toBeLessThan(1);
    expect(geometry.shellWidth, `viewport ${width}`).toBeLessThanOrEqual(880);
    expect(geometry.pageFits, `viewport ${width}`).toBe(true);
    expect(geometry.bodyPaddingBottom, `viewport ${width}`).toBe("0px");
  }
});
