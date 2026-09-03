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
      <div class="admin-users-shell">
        <div class="admin-shell">
          <aside class="admin-shell__sidebar">
            <section class="admin-identity">
              <span class="admin-identity__avatar">A</span>
              <div class="admin-identity__copy"><strong>Admin</strong></div>
            </section>
          </aside>
          <div class="admin-shell__content">
            <section class="admin-users-list">
              <div class="admin-users-table-wrap">
                <table class="admin-users-table">
                  <tbody>
                    <tr>
                      <td>Account</td>
                      <td>Created</td>
                      <td>Tier</td>
                      <td>Actions</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  `;
}

test("uses balanced safe gutters and contains overflow across admin breakpoints", async ({
  page,
}) => {
  const stylesheet = await readFile(stylesheetUrl, "utf8");
  await page.setContent(fixture(stylesheet));

  for (const width of [1280, 1440, 1800]) {
    await page.setViewportSize({ height: 900, width });
    const geometry = await page.evaluate((viewportWidth) => {
      const shell = document.querySelector<HTMLElement>(".admin-users-shell");
      const content = document.querySelector<HTMLElement>(
        ".admin-shell__content",
      );
      const tableWrap = document.querySelector<HTMLElement>(
        ".admin-users-table-wrap",
      );
      if (!shell || !content || !tableWrap) {
        throw new Error("Admin fixture is incomplete");
      }

      const rect = shell.getBoundingClientRect();
      return {
        contentWidth: content.getBoundingClientRect().width,
        left: rect.left,
        pageFits:
          document.documentElement.scrollWidth ===
          document.documentElement.clientWidth,
        right: viewportWidth - rect.right,
        tableOverflow: getComputedStyle(tableWrap).overflowX,
      };
    }, width);

    expect(
      Math.abs(geometry.left - geometry.right),
      `viewport ${width}`,
    ).toBeLessThan(1);
    expect(geometry.left, `viewport ${width}`).toBeLessThanOrEqual(40);
    expect(geometry.pageFits, `viewport ${width}`).toBe(true);
    expect(geometry.tableOverflow, `viewport ${width}`).toBe("auto");
    expect(geometry.contentWidth, `viewport ${width}`).toBeGreaterThan(
      width - 340,
    );
  }

  await page.setViewportSize({ height: 844, width: 390 });
  const mobile = await page.evaluate(() => {
    const layout = document.querySelector<HTMLElement>(".admin-shell");
    const tableWrap = document.querySelector<HTMLElement>(
      ".admin-users-table-wrap",
    );
    if (!layout || !tableWrap) {
      throw new Error("Admin fixture is incomplete");
    }

    return {
      layoutDisplay: getComputedStyle(layout).display,
      pageFits:
        document.documentElement.scrollWidth ===
        document.documentElement.clientWidth,
      tableOverflow: getComputedStyle(tableWrap).overflowX,
    };
  });

  expect(mobile.layoutDisplay).toBe("block");
  expect(mobile.pageFits).toBe(true);
  expect(mobile.tableOverflow).toBe("auto");
});
