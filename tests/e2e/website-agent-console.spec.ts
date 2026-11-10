import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  actionPath,
  fetchObservations,
  fixtureTime,
  origin,
  pendingSession,
  queryPath,
  queryReply,
  reviewedAction,
  session,
  sessionPath,
  SyntheticWebsiteApi,
} from "./fixtures/website-agent-fixture";

const test = base.extend<{ api: SyntheticWebsiteApi }>({
  api: async ({ page }, use) => {
    const api = new SyntheticWebsiteApi();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    // Fixed Date.now keeps review deadlines deterministic without freezing timers.
    await page.clock.setFixedTime(fixtureTime);
    await api.install(page);
    await use(api);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect(api.unexpectedRequests, "Every request must stay in the synthetic fixture").toEqual([]);
    expect(errors, "The real component must not throw in the browser").toEqual([]);
    for (const call of api.calls.filter(item => item.method === "POST" && /\/actions\//u.test(item.path))) {
      const approve = call.path.endsWith("/approve");
      expect(Object.keys(call.body ?? {}).sort(), "No decision or replay may send replacement arguments").toEqual(
        approve ? ["approval", "expected_arguments_hash", "expected_revision"] : ["expected_revision"],
      );
      if (approve) {
        expect(call.body?.approval).toBe(true);
        expect(call.body?.expected_arguments_hash).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
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

function reviewCard(page: Page, title: string) {
  return page.getByRole("region", { name: `操作确认：${title}`, exact: true });
}

async function settleBrowserRender(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
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

test("renders every reviewed detail and consequence as literal text and requires its own explicit checkbox", async ({ page, api }) => {
  const action = reviewedAction(1, { review: {
    title: "Synthetic exact review",
    details: [
      { label: "目标 ID", value: "synthetic-target-001" },
      { label: "全部参数", value: 'visibility=private\nannotation="Keep this exact value"' },
      { label: "原始文本", value: '<img src="https://invalid.example.test/tracker" onerror="alert(1)">' },
    ],
    consequences: ["Only synthetic-target-001 will change.", "This choice cannot undo any previous action."],
  } });
  api.seed([session(1, { actions: [action] })]);
  await open(page);
  const card = reviewCard(page, action.review.title);
  await expect(card.getByRole("heading", { level: 3 })).toHaveText(action.review.title);
  expect(await card.locator("dt").allTextContents()).toEqual(action.review.details.map(detail => detail.label));
  expect(await card.locator("dd").allTextContents()).toEqual(action.review.details.map(detail => detail.value));
  expect(await card.getByRole("listitem").allTextContents()).toEqual(action.review.consequences);
  await expect(card.locator("img, script")).toHaveCount(0);
  await expect(card.getByText("待确认", { exact: true })).toBeVisible();
  const checkbox = card.getByRole("checkbox");
  const confirm = card.getByRole("button", { name: "确认执行", exact: true });
  await expect(checkbox).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  // Model data consent is not approval of a proposed database action.
  await page.locator('input[name="data_consent"]').check();
  await expect(confirm).toBeDisabled();
  await checkbox.check();
  await expect(confirm).toBeEnabled();
  await checkbox.uncheck();
  await expect(confirm).toBeDisabled();
  expect(api.calls.filter(call => call.method === "POST")).toEqual([]);
});

test("confirms only the exact reviewed hash and revision once and excludes concurrent decisions", async ({ page, api }) => {
  const action = reviewedAction(1), other = reviewedAction(2);
  const view = session(1, { revision: 7, actions: [action, other] });
  api.seed([view, session(2)]);
  await open(page);
  const path = actionPath(view.id, action.id, "approve");
  const held = api.holdNext("POST", path);
  const card = reviewCard(page, action.review.title);
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "确认执行", exact: true }).evaluate(button => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const call = await held.received;
  expect(call).toEqual({ method: "POST", path, body: {
    expected_revision: 7, expected_arguments_hash: action.argumentsHash, approval: true,
  } });
  await expect(card.getByRole("button", { name: "确认执行", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "拒绝这项操作", exact: true })).toBeDisabled();
  await expect(reviewCard(page, other.review.title).getByRole("checkbox")).toBeDisabled();
  await expect(page.getByRole("button", { name: "刷新会话", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "选择会话" })).toBeDisabled();
  await expect(page.getByRole("textbox")).toBeDisabled();
  expect(api.count("POST", path)).toBe(1);
  await held.respond({ session: { ...view, revision: 8, actions: [
    { ...action, status: "completed", receipt: { ok: true, code: "completed", message: "Only the exact reviewed action completed." } }, other,
  ] } });
  await expect(card.getByRole("status")).toHaveText("Only the exact reviewed action completed.");
  await expect(card.getByRole("button", { name: "确认执行", exact: true })).toHaveCount(0);
  await expect(reviewCard(page, other.review.title).getByRole("button", { name: "确认执行", exact: true })).toBeDisabled();
  expect(api.calls.filter(item => item.method === "POST")).toEqual([call]);
  expect(api.count("POST", queryPath)).toBe(0);
});

test("declines without approval and sends only the selected session revision", async ({ page, api }) => {
  const action = reviewedAction(1), view = session(1, { revision: 4, actions: [action] });
  api.seed([view]);
  await open(page);
  const card = reviewCard(page, action.review.title);
  await expect(card.getByRole("checkbox")).not.toBeChecked();
  const path = actionPath(view.id, action.id, "decline"), held = api.holdNext("POST", path);
  await card.getByRole("button", { name: "拒绝这项操作", exact: true }).click();
  const call = await held.received;
  expect(call).toEqual({ method: "POST", path, body: { expected_revision: 4 } });
  await held.respond({ session: { ...view, revision: 5, actions: [{ ...action, status: "cancelled" }] } });
  await expect(card.getByText("已取消", { exact: true })).toBeVisible();
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(api.calls.filter(item => item.method === "POST")).toEqual([call]);
});

for (const state of ["completed", "unknown", "expired", "executing"] as const) {
  test(`keeps a ${state} action read-only across refresh and reload without retrying it`, async ({ page, api }) => {
    const action = reviewedAction(1, {
      status: state,
      receipt: state === "completed" || state === "unknown"
        ? { ok: state === "completed", code: state, message: `Synthetic ${state} receipt` } : null,
    });
    api.seed([session(1, { actions: [action] })]);
    await open(page);
    const card = reviewCard(page, action.review.title);
    await expect(card.getByRole("button")).toHaveCount(0);
    await expect(card.getByRole("checkbox")).toHaveCount(0);
    if (state === "unknown") await expect(card).toContainText("这项操作不会自动重试");
    if (action.receipt) await expect(card.getByRole("status")).toHaveText(action.receipt.message);
    await page.getByRole("button", { name: "刷新会话", exact: true }).click();
    await expect(page.getByRole("button", { name: "刷新会话", exact: true })).toBeEnabled();
    await page.reload();
    await expect(card).toBeVisible();
    await expect(card.getByRole("button")).toHaveCount(0);
    expect(api.calls.filter(call => call.method === "POST")).toEqual([]);
  });
}

test("makes an already expired pending card non-actionable without sending a decision", async ({ page, api }) => {
  const action = reviewedAction(1, { expiresAt: new Date(fixtureTime - 1).toISOString() });
  api.seed([session(1, { actions: [action] })]);
  await open(page);
  const card = reviewCard(page, action.review.title);
  await expect(card.getByText("已过期", { exact: true })).toBeVisible();
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  expect(api.calls.filter(call => call.method === "POST")).toEqual([]);
});

test("expires an already checked review card on its timer without another user interaction", async ({ page, api }) => {
  const action = reviewedAction(1, { expiresAt: new Date(fixtureTime + 2_000).toISOString() });
  api.seed([session(1, { actions: [action] })]);
  await open(page);
  const card = reviewCard(page, action.review.title);
  await card.getByRole("checkbox").check();
  await expect(card.getByRole("button", { name: "确认执行", exact: true })).toBeEnabled();
  // Move wall time beyond expiry while leaving the real timeout running. No
  // click, refresh or parent state change should be needed to retire the card.
  await page.clock.setFixedTime(fixtureTime + 2_001);
  await expect(card.getByText("已过期", { exact: true })).toBeVisible();
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(api.calls.filter(call => call.method === "POST")).toEqual([]);
});

test("checks expiry at confirmation time even before the scheduled expiry rerender", async ({ page, api }) => {
  const action = reviewedAction(1);
  api.seed([session(1, { actions: [action] })]);
  await open(page);
  const card = reviewCard(page, action.review.title);
  await card.getByRole("checkbox").check();
  await page.clock.setFixedTime(fixtureTime + 300_001);
  await card.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("这项确认已过期");
  expect(api.calls.filter(call => call.method === "POST")).toEqual([]);
});

test("polls a reconnected executing action with no model run and stops after its receipt arrives", async ({ page, api }) => {
  const action = reviewedAction(1, { status: "executing" });
  const other = reviewedAction(2);
  const view = session(1, { pending: null, actions: [action, other] });
  api.seed([view]);
  await open(page);
  const card = reviewCard(page, action.review.title);
  await expect(card.getByText("执行中", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toBeDisabled();
  await expect(reviewCard(page, other.review.title).getByRole("checkbox")).toBeDisabled();
  await expect(reviewCard(page, other.review.title).getByRole("button", { name: "确认执行", exact: true })).toBeDisabled();
  // A soft close stays available; it does not promise to undo an existing effect.
  await expect(page.getByRole("button", { name: "结束会话", exact: true })).toBeEnabled();
  // Even a directly dispatched event must hit the executing-action method guard.
  await page.locator("form").dispatchEvent("submit");
  const poll = api.holdNext("GET", `${sessionPath}/${view.id}`);
  await poll.received;
  await poll.respond({ session: { ...view, revision: 2, actions: [{ ...action, status: "completed", receipt: {
    ok: true, code: "completed", message: "Reconnected execution receipt",
  } }, other] } });
  await expect(card.getByRole("status")).toHaveText("Reconnected execution receipt");
  await expect(page.getByRole("textbox")).toBeEnabled();
  await expect(reviewCard(page, other.review.title).getByRole("checkbox")).toBeEnabled();
  await expect(reviewCard(page, other.review.title).getByRole("button", { name: "确认执行", exact: true })).toBeDisabled();
  const reads = api.count("GET", `${sessionPath}/${view.id}`);
  await page.waitForTimeout(1_700);
  expect(api.count("GET", `${sessionPath}/${view.id}`)).toBe(reads);
  expect(api.calls.filter(call => call.method === "POST")).toEqual([]);
});

test("requires fresh review after refresh changes the revision, parameters and hash", async ({ page, api }) => {
  const action = reviewedAction(1), view = session(1, { revision: 2, actions: [action] });
  api.seed([view]);
  await open(page);
  const card = reviewCard(page, action.review.title);
  await card.getByRole("checkbox").check();
  const updated = { ...action, argumentsHash: "f".repeat(64), review: {
    ...action.review, details: [{ label: "目标", value: "New reviewed target" }],
  } };
  const fresh = { ...view, revision: 3, actions: [updated] };
  const refresh = api.holdNext("GET", `${sessionPath}/${view.id}`);
  await page.getByRole("button", { name: "刷新会话", exact: true }).click();
  await refresh.received;
  await expect(card.getByRole("button", { name: "确认执行", exact: true })).toBeDisabled();
  await refresh.respond({ session: fresh });
  await expect(card.locator("dd")).toHaveText("New reviewed target");
  await expect(card.getByRole("checkbox")).not.toBeChecked();
  await expect(card.getByRole("button", { name: "确认执行", exact: true })).toBeDisabled();
  expect(api.calls.filter(call => call.method === "POST")).toEqual([]);
  const approve = api.holdNext("POST", actionPath(view.id, action.id, "approve"));
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "确认执行", exact: true }).click();
  expect((await approve.received).body).toEqual({ expected_revision: 3, expected_arguments_hash: updated.argumentsHash, approval: true });
  await approve.respond({ session: { ...fresh, revision: 4, actions: [{ ...updated, status: "completed", receipt: {
    ok: true, code: "completed", message: "Freshly reviewed version completed",
  } }] } });
  await expect(card.getByRole("status")).toHaveText("Freshly reviewed version completed");
});

test("does not carry a checked approval across session switches even when action IDs match", async ({ page, api }) => {
  const action = reviewedAction(1);
  const first = session(1, { actions: [action] });
  const secondAction = { ...action, argumentsHash: "b".repeat(64), review: { ...action.review, title: "Other session review" } };
  const second = session(2, { actions: [secondAction] });
  api.seed([first, second]);
  await open(page);
  await reviewCard(page, action.review.title).getByRole("checkbox").check();
  await page.getByRole("combobox", { name: "选择会话" }).selectOption(second.id);
  await expect(reviewCard(page, secondAction.review.title).getByRole("checkbox")).not.toBeChecked();
  await expect(reviewCard(page, secondAction.review.title).getByRole("button", { name: "确认执行", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "选择会话" }).selectOption(first.id);
  await expect(reviewCard(page, action.review.title).getByRole("checkbox")).not.toBeChecked();
  expect(api.calls.filter(call => call.method === "POST")).toEqual([]);
});

test("ignores a late action card from a previous session poll after switching", async ({ page, api }) => {
  const action = reviewedAction(1), currentAction = reviewedAction(2);
  const first = pendingSession(1, { actions: [action] }), second = session(2, { actions: [currentAction] });
  api.seed([first, second]);
  await open(page);
  await watchForStaleText(page, "STALE ACTION REVIEW");
  const poll = api.holdNext("GET", `${sessionPath}/${first.id}`);
  await poll.received;
  await page.getByRole("combobox", { name: "选择会话" }).selectOption(second.id);
  await expect(reviewCard(page, currentAction.review.title)).toBeVisible();
  await expectAborted(page, "GET", `${sessionPath}/${first.id}`);
  await poll.respond({ session: { ...first, revision: 100, actions: [{ ...action, review: { ...action.review, title: "STALE ACTION REVIEW" } }] } }, { clientAborted: true });
  await page.getByRole("button", { name: "刷新会话", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新会话", exact: true })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "选择会话" })).toHaveValue(second.id);
  await expect(reviewCard(page, currentAction.review.title).getByRole("checkbox")).not.toBeChecked();
  await expect(page.locator("#fixture-root")).not.toHaveAttribute("data-stale-seen", "true");
  expect(api.calls.filter(call => call.method === "POST")).toEqual([]);
});

test("aborts an action decision on unmount and ignores its late receipt", async ({ page, api }) => {
  const action = reviewedAction(1), view = session(1, { actions: [action] });
  api.seed([view]);
  await open(page);
  const path = actionPath(view.id, action.id, "approve"), held = api.holdNext("POST", path);
  const card = reviewCard(page, action.review.title);
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "确认执行", exact: true }).click();
  await held.received;
  await page.getByRole("button", { name: "Unmount test component", exact: true }).click();
  await expectAborted(page, "POST", path);
  await held.respond({ session: { ...view, revision: 2, actions: [{ ...action, status: "completed", receipt: {
    ok: true, code: "completed", message: "LATE ACTION RECEIPT",
  } }] } }, { clientAborted: true });
  await settleBrowserRender(page);
  await expect(page.locator("#fixture-root")).toBeEmpty();
  expect(api.count("POST", path)).toBe(1);
  expect(api.count("GET", `${sessionPath}/${view.id}`)).toBe(1);
});

for (const operation of ["refresh", "session switch"] as const) {
  test(`ignores a late ${operation} review response after unmount`, async ({ page, api }) => {
    const action = reviewedAction(1), first = session(1, { actions: [action] }), second = session(2, { actions: [action] });
    api.seed([first, second]);
    await open(page);
    await watchForStaleText(page, "LATE REVIEW AFTER UNMOUNT");
    const target = operation === "refresh" ? first : second;
    const held = api.holdNext("GET", `${sessionPath}/${target.id}`);
    if (operation === "refresh") await page.getByRole("button", { name: "刷新会话", exact: true }).click();
    else await page.getByRole("combobox", { name: "选择会话" }).selectOption(second.id);
    await held.received;
    await page.getByRole("button", { name: "Unmount test component", exact: true }).click();
    const response = page.waitForResponse(`${origin}${sessionPath}/${target.id}`);
    await held.respond({ session: { ...target, revision: 2, actions: [{ ...action, review: { ...action.review, title: "LATE REVIEW AFTER UNMOUNT" } }] } });
    await response;
    await settleBrowserRender(page);
    await expect(page.locator("#fixture-root")).toBeEmpty();
    await expect(page.locator("#fixture-root")).not.toHaveAttribute("data-stale-seen", "true");
    expect(api.calls.filter(call => call.method === "POST")).toEqual([]);
  });
}

test("rejects a decision reply for another session and refreshes only the selected session", async ({ page, api }) => {
  const action = reviewedAction(1), view = session(1, { actions: [action] });
  api.seed([view]);
  await open(page);
  await watchForStaleText(page, "FOREIGN ACTION RECEIPT");
  const held = api.holdNext("POST", actionPath(view.id, action.id, "approve"));
  const card = reviewCard(page, action.review.title);
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "确认执行", exact: true }).click();
  await held.received;
  api.sessions.set(view.id, { ...view, revision: 2, actions: [{ ...action, status: "unknown", receipt: {
    ok: false, code: "outcome_unknown", message: "Selected session needs reconciliation",
  } }] });
  await held.respond({ session: session(99, { actions: [{ ...action, status: "completed", receipt: {
    ok: true, code: "completed", message: "FOREIGN ACTION RECEIPT",
  } }] }) });
  await expect(card.getByRole("status")).toHaveText("Selected session needs reconciliation");
  await expect(page.getByRole("combobox", { name: "选择会话" })).toHaveValue(view.id);
  await expect(page.locator("#fixture-root")).not.toHaveAttribute("data-stale-seen", "true");
  expect(api.count("GET", `${sessionPath}/${session(99).id}`)).toBe(0);
  expect(api.count("POST", queryPath)).toBe(0);
});

test("reconciles an uncertain decision with a read and never retries the effect", async ({ page, api }) => {
  const action = reviewedAction(1), view = session(1, { actions: [action] });
  api.seed([view]);
  await open(page);
  const path = actionPath(view.id, action.id, "approve");
  api.failNext("POST", path);
  api.sessions.set(view.id, { ...view, revision: 2, actions: [{ ...action, status: "unknown", receipt: {
    ok: false, code: "outcome_unknown", message: "Synthetic uncertain result: check current state first",
  } }] });
  const card = reviewCard(page, action.review.title);
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("不会自动重试");
  await expect(card.getByRole("status")).toHaveText("Synthetic uncertain result: check current state first");
  expect(api.count("POST", path)).toBe(1);
  expect(api.count("GET", `${sessionPath}/${view.id}`)).toBe(2);
  await page.getByRole("button", { name: "刷新会话", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Synthetic uncertain result: check current state first");
  await expect(card.getByRole("button")).toHaveCount(0);
  await page.reload();
  await expect(card.getByText("结果不确定", { exact: true })).toBeVisible();
  expect(api.count("POST", path)).toBe(1);
});

test("reconciles an expired decision response without automatically submitting it again", async ({ page, api }) => {
  const action = reviewedAction(1), view = session(1, { actions: [action] });
  api.seed([view]);
  await open(page);
  const path = actionPath(view.id, action.id, "approve");
  api.replyNext("POST", path, { error: { code: "action_expired" } }, 409);
  api.sessions.set(view.id, { ...view, revision: 2, actions: [{ ...action, status: "expired" }] });
  const card = reviewCard(page, action.review.title);
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("这项确认已过期");
  await expect(card.getByText("已过期", { exact: true })).toBeVisible();
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(api.count("POST", path)).toBe(1);
  expect(api.count("POST", queryPath)).toBe(0);
});

for (const width of [320, 375, 390]) {
  test(`keeps long review parameters and consequences within a ${width}px mobile viewport`, async ({ page, api }, testInfo) => {
    const action = reviewedAction(1, { review: {
      title: `Synthetic review ${"r".repeat(150)}`,
      details: [
        { label: "Exact long target URL", value: `https://example.test/${"target".repeat(400)}` },
        { label: "Exact multiline parameters", value: `First line\n${"参数".repeat(300)}\nFinal line` },
      ],
      consequences: [`This exact consequence remains visible: ${"long-value".repeat(80)}`],
    } });
    api.seed([session(1, { actions: [action] })]);
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    const card = reviewCard(page, action.review.title);
    expect(await card.locator("dd").allTextContents()).toEqual(action.review.details.map(detail => detail.value));
    const dimensions = await card.evaluate(element => ({
      viewport: window.innerWidth, document: document.documentElement.scrollWidth,
      items: Array.from(element.querySelectorAll<HTMLElement>("h3, dd, li, button"))
        .map(item => ({ text: item.textContent?.slice(0, 50), left: item.getBoundingClientRect().left, right: item.getBoundingClientRect().right })),
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    for (const item of dimensions.items) {
      expect(item.left, item.text ?? "review left edge").toBeGreaterThanOrEqual(0);
      expect(item.right, item.text ?? "review right edge").toBeLessThanOrEqual(width);
    }
    const screenshot = testInfo.outputPath(`website-agent-review-mobile-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`Actual review card at ${width}px`, { path: screenshot, contentType: "image/png" });
  });
}

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
