import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  fetchObservations,
  origin,
  pendingSession,
  queryPath,
  queryReply,
  session,
  sessionPath,
  SyntheticWebsiteApi,
} from "./fixtures/website-agent-fixture";

const test = base.extend<{ api: SyntheticWebsiteApi }>({
  api: async ({ page }, use) => {
    const api = new SyntheticWebsiteApi();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await api.install(page);
    await use(api);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect(api.unexpectedRequests, "Every request must stay in the synthetic fixture").toEqual([]);
    expect(errors, "The real component must not throw in the browser").toEqual([]);
  },
});

async function open(page: Page, id?: string) {
  await page.goto(`${origin}/agent/website${id ? `?session=${encodeURIComponent(id)}` : ""}`);
  await expect(page.getByRole("status", { name: "", exact: true }).filter({ hasText: "正在读取会话" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建会话", exact: true })).toBeEnabled();
}

async function ask(page: Page, question = "Synthetic question") {
  await page.getByRole("textbox", { name: "询问 Attention" }).fill(question);
  await page.locator('input[name="data_consent"]').check();
  await page.getByRole("button", { name: "询问网页助手", exact: true }).click();
}

async function expectAborted(page: Page, method: string, path: string) {
  await expect.poll(async () => (await fetchObservations(page))
    .some(record => record.method === method && record.path === path && record.aborted)).toBe(true);
}

async function watchForStaleText(page: Page, text: string) {
  await page.locator("#fixture-root").evaluate((root, forbidden) => {
    const observer = new MutationObserver(() => {
      if (root.textContent?.includes(forbidden) && !root.hasAttribute("data-stale-seen")) {
        root.setAttribute("data-stale-seen", "true");
      }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }, text);
}

test("creates an account session and requires explicit consent before submitting", async ({ page, api }) => {
  await open(page);
  await expect(page.getByRole("textbox")).toBeDisabled();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeEnabled();
  const created = api.sessions.values().next().value;
  expect(created).toBeDefined();
  if (!created) throw new Error("Synthetic create did not produce a session");
  expect(api.calls.find(call => call.method === "POST" && call.path === sessionPath)?.body).toEqual({});
  await expect(page).toHaveURL(`${origin}/agent/website?session=${created.id}`);

  await page.getByRole("textbox").fill("Consent-gated synthetic question");
  await page.getByRole("button", { name: "询问网页助手", exact: true }).click();
  expect(api.count("POST", queryPath)).toBe(0);
  await expect(page.locator('input[name="data_consent"]')).not.toBeChecked();
  expect(await page.locator("form").evaluate(form => (form as HTMLFormElement).checkValidity())).toBe(false);

  const held = api.holdNext("POST", queryPath);
  await page.locator('input[name="data_consent"]').check();
  await page.locator('input[name="collect"]').check();
  await page.locator('input[name="read_sources"]').check();
  await page.getByRole("button", { name: "询问网页助手", exact: true }).click();
  const call = await held.received;
  expect(call.body).toMatchObject({
    query: "Consent-gated synthetic question", session_id: created.id,
    expected_revision: created.revision, data_consent: true, collect: true, read_sources: true,
  });
  expect(call.body?.operation_id).toMatch(/^[0-9a-f-]{36}$/u);
  await held.respond(queryReply(created, "Consent-gated synthetic question"));
  await expect(page.getByText("Synthetic grounded answer", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveValue("");
  await expect(page.locator('input[name="data_consent"]')).not.toBeChecked();
  await expect(page.locator('input[name="collect"]')).not.toBeChecked();
  await expect(page.locator('input[name="read_sources"]')).not.toBeChecked();
});

test("selects existing sessions and preserves each history and URL", async ({ page, api }) => {
  const first = session(1, { messages: [{ role: "assistant", text: "First private synthetic history" }] });
  const second = session(2, { messages: [{ role: "assistant", text: "Second private synthetic history" }] });
  api.seed([first, second]);
  await open(page);
  await expect(page.getByText("First private synthetic history", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "选择会话" }).selectOption(second.id);
  await expect(page.getByText("Second private synthetic history", { exact: true })).toBeVisible();
  await expect(page.getByText("First private synthetic history", { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(`${origin}/agent/website?session=${second.id}`);
  await page.getByRole("combobox", { name: "选择会话" }).selectOption(first.id);
  await expect(page.getByText("First private synthetic history", { exact: true })).toBeVisible();
  expect(api.count("POST", queryPath)).toBe(0);
});

test("resolves a deep-linked session even when it is outside the list page", async ({ page, api }) => {
  const listed = session(1);
  const linked = session(77, { messages: [{ role: "assistant", text: "Deep-linked synthetic history" }] });
  api.seed([listed, linked], [listed.id]);
  await open(page, linked.id);
  await expect(page.getByText("Deep-linked synthetic history", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "选择会话" })).toHaveValue(linked.id);
  expect(api.count("GET", `${sessionPath}/${linked.id}`)).toBe(1);
  expect(api.count("GET", `${sessionPath}/${listed.id}`)).toBe(0);
});

test("does not silently replace an unavailable deep link with another session", async ({ page, api }) => {
  const listed = session(1);
  api.seed([listed]);
  await open(page, session(99).id);
  await expect(page.getByRole("alert")).toContainText("会话不存在或不属于当前账号");
  await expect(page.getByRole("textbox")).toBeDisabled();
  expect(api.count("GET", `${sessionPath}/${listed.id}`)).toBe(0);
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("resumes a pending session after reload by polling without another paid query", async ({ page, api }) => {
  const view = pendingSession(1, { messages: [{ role: "assistant", text: "Saved before reconnect" }] });
  api.seed([view]);
  await open(page, view.id);
  await expect(page.getByRole("textbox")).toBeDisabled();
  await expect(page.getByRole("button", { name: "结束会话", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByText("Saved before reconnect", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Synthetic request already running");
  const complete = queryReply(view, "Earlier synthetic question", "Recovered completed answer").session;
  api.sessions.set(view.id, complete);
  await expect(page.getByText("Recovered completed answer", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toBeEnabled();
  expect(api.count("POST", queryPath)).toBe(0);
  const completedReads = api.count("GET", `${sessionPath}/${view.id}`);
  // Observe one full polling cadence after completion: no timer should remain.
  await page.waitForTimeout(1_700);
  expect(api.count("GET", `${sessionPath}/${view.id}`)).toBe(completedReads);
});

test("closes the selected revision and keeps a closed deep link read-only", async ({ page, api }) => {
  const view = session(1, { revision: 7, messages: [{ role: "assistant", text: "Preserved closed history" }] });
  api.seed([view]);
  await open(page, view.id);
  await page.getByRole("button", { name: "结束会话", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeDisabled();
  expect(api.calls.find(call => call.path === `${sessionPath}/${view.id}/close`)?.body).toEqual({ expected_revision: 7 });
  await expect(page.getByText("这个会话不能继续提问", { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Preserved closed history", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toBeDisabled();
  await expect(page.getByRole("button", { name: "结束会话", exact: true })).toHaveCount(0);
  expect(api.count("POST", queryPath)).toBe(0);
});

test("admits only one request for repeated submit events and locks conflicting controls", async ({ page, api }) => {
  const view = session(1);
  api.seed([view, session(2)]);
  await open(page);
  const held = api.holdNext("POST", queryPath);
  await page.getByRole("textbox").fill("Only once");
  await page.locator('input[name="data_consent"]').check();
  // Same-turn events exercise the active-request ref before a React rerender,
  // unlike two clicks that merely hit an already-disabled button.
  await page.locator("form").evaluate(form => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  const call = await held.received;
  expect(call.body).toMatchObject({ collect: false, read_sources: false, data_consent: true });
  await expect(page.getByRole("button", { name: "停止等待", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建会话", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "刷新会话", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "结束会话", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "选择会话" })).toBeDisabled();
  expect(api.count("POST", queryPath)).toBe(1);
  await held.respond(queryReply(view, "Only once"));
  await expect(page.getByText("Synthetic grounded answer", { exact: true })).toBeVisible();
  expect(api.count("POST", queryPath)).toBe(1);
});

test("rejects an older poll revision without briefly displaying its stale history", async ({ page, api }) => {
  const view = pendingSession(1, { revision: 8, messages: [{ role: "assistant", text: "Latest accepted history" }] });
  api.seed([view]);
  await open(page);
  await watchForStaleText(page, "STALE LOWER REVISION");
  const held = api.holdNext("GET", `${sessionPath}/${view.id}`);
  await held.received;
  await held.respond({ session: { ...view, revision: 7, messages: [{ role: "assistant", text: "STALE LOWER REVISION" }] } });
  const complete = queryReply(view, "Finished question", "New revision accepted").session;
  api.sessions.set(view.id, complete);
  await expect(page.getByText("New revision accepted", { exact: true })).toBeVisible();
  await expect(page.getByText("Latest accepted history", { exact: true })).toBeVisible();
  await expect(page.locator("#fixture-root")).not.toHaveAttribute("data-stale-seen", "true");
  expect(api.count("POST", queryPath)).toBe(0);
});

test("aborts an old poll when selecting another session and never overwrites the new selection", async ({ page, api }) => {
  const first = pendingSession(1);
  const second = session(2, { messages: [{ role: "assistant", text: "Selected second session" }] });
  api.seed([first, second]);
  await open(page);
  await watchForStaleText(page, "STALE OTHER SESSION");
  const held = api.holdNext("GET", `${sessionPath}/${first.id}`);
  await held.received;
  await page.getByRole("combobox", { name: "选择会话" }).selectOption(second.id);
  await expect(page.getByText("Selected second session", { exact: true })).toBeVisible();
  await expectAborted(page, "GET", `${sessionPath}/${first.id}`);
  await held.respond({ session: { ...first, revision: 100, messages: [{ role: "assistant", text: "STALE OTHER SESSION" }] } }, { clientAborted: true });
  await page.getByRole("button", { name: "刷新会话", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "选择会话" })).toHaveValue(second.id);
  await expect(page.getByRole("button", { name: "刷新会话", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(`${origin}/agent/website?session=${second.id}`);
  await expect(page.locator("#fixture-root")).not.toHaveAttribute("data-stale-seen", "true");
});

test("cancels waiting, aborts transport, and isolates a later submission from the canceled answer", async ({ page, api }) => {
  const view = session(1);
  api.seed([view]);
  await open(page);
  await watchForStaleText(page, "STALE CANCELED ANSWER");
  const first = api.holdNext("POST", queryPath);
  await ask(page, "First canceled question");
  const firstCall = await first.received;
  await page.getByRole("button", { name: "停止等待", exact: true }).click();
  await expectAborted(page, "POST", queryPath);
  await expect(page.getByRole("alert")).toContainText("已停止等待，并请求取消后续处理");
  await expect(page.getByRole("alert")).toContainText("已提交的收藏不会撤销");
  await expect(page.getByRole("textbox")).toBeEnabled();

  const second = api.holdNext("POST", queryPath);
  await ask(page, "Second independent question");
  const secondCall = await second.received;
  expect(secondCall.body?.operation_id).not.toBe(firstCall.body?.operation_id);
  await first.respond(queryReply(view, "First canceled question", "STALE CANCELED ANSWER"), { clientAborted: true });
  await second.respond(queryReply(view, "Second independent question", "Current answer only"));
  await expect(page.getByText("Current answer only", { exact: true })).toBeVisible();
  await expect(page.locator("#fixture-root")).not.toHaveAttribute("data-stale-seen", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(api.count("POST", queryPath)).toBe(2);
});

test("aborts the initial list fetch on unmount without remounting after a late reply", async ({ page, api }) => {
  const held = api.holdNext("GET", sessionPath);
  await page.goto(`${origin}/agent/website`);
  await held.received;
  await page.getByRole("button", { name: "Unmount test component", exact: true }).click();
  await expectAborted(page, "GET", sessionPath);
  await held.respond({ sessions: [session(1)] }, { clientAborted: true });
  await expect(page.locator("#fixture-root")).toBeEmpty();
  expect(api.calls).toHaveLength(1);
});

test("aborts an in-flight query on unmount and does not issue recovery reads", async ({ page, api }) => {
  const view = session(1);
  api.seed([view]);
  await open(page);
  const held = api.holdNext("POST", queryPath);
  await ask(page);
  await held.received;
  await page.getByRole("button", { name: "Unmount test component", exact: true }).click();
  await expectAborted(page, "POST", queryPath);
  await held.respond(queryReply(view), { clientAborted: true });
  await expect(page.locator("#fixture-root")).toBeEmpty();
  expect(api.count("GET", `${sessionPath}/${view.id}`)).toBe(1);
  expect(api.count("POST", queryPath)).toBe(1);
});

test("aborts an in-flight poll and removes its interval on unmount", async ({ page, api }) => {
  const view = pendingSession(1);
  api.seed([view]);
  await open(page);
  const held = api.holdNext("GET", `${sessionPath}/${view.id}`);
  await held.received;
  await page.getByRole("button", { name: "Unmount test component", exact: true }).click();
  await expectAborted(page, "GET", `${sessionPath}/${view.id}`);
  await held.respond({ session: view }, { clientAborted: true });
  const reads = api.count("GET", `${sessionPath}/${view.id}`);
  await page.waitForTimeout(1_700);
  expect(api.count("GET", `${sessionPath}/${view.id}`)).toBe(reads);
  await expect(page.locator("#fixture-root")).toBeEmpty();
});

for (const width of [320, 375, 390]) {
  test(`keeps the actual composer and long history within a ${width}px mobile viewport`, async ({ page, api }, testInfo) => {
    const view = session(1, { messages: [
      { role: "user", text: `Synthetic long URL https://example.test/${"a".repeat(240)}` },
      { role: "assistant", text: `Synthetic answer ${"正文与引用".repeat(60)}` },
    ] });
    api.seed([view, session(2)]);
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    await page.getByRole("textbox").fill("Synthetic mobile question");
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      controls: Array.from(document.querySelectorAll<HTMLElement>(".website-agent-console button, .website-agent-console select, .website-agent-console textarea"))
        .map(element => ({ label: element.textContent, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })),
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    for (const control of dimensions.controls) {
      expect(control.left, control.label ?? "control left edge").toBeGreaterThanOrEqual(0);
      expect(control.right, control.label ?? "control right edge").toBeLessThanOrEqual(width);
    }
    const screenshot = testInfo.outputPath(`website-agent-mobile-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`Actual component at ${width}px`, { path: screenshot, contentType: "image/png" });
  });
}
