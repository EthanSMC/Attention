import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import type { WebsiteAgentSessionView } from "../../apps/web/src/server/website-agent-sessions";
import { digestAnswer, digestPrompt, helloAnswer, helloPrompt, resumeAnswer, resumePrompt } from "./fixtures/website-agent-offline-provider";
import { productionOrigin, test } from "./fixtures/website-agent-production-fixture";

type SessionBody = { session: WebsiteAgentSessionView; answer?: string };
const sessionsPath = "/api/website-agent/sessions";
const queryPath = "/api/website-agent/query";

test("real standalone HTTP authenticates, persists native state, and resumes after process restart", async ({ production }) => {
  const actor = await production.member();
  const unauthenticated = await production.request(sessionsPath);
  expect(unauthenticated.status).toBe(401);
  expect(await unauthenticated.json()).toMatchObject({ error: { code: "authentication_required" } });
  const created = await production.request(sessionsPath, actor, {});
  expect(created.status).toBe(201);
  const { session } = await created.json() as SessionBody;
  const queried = await production.request(queryPath, actor, { query: helloPrompt, session_id: session.id,
    expected_revision: session.revision, operation_id: randomUUID(), data_consent: true });
  expect(queried.status).toBe(200);
  expect(queried.headers.get("cache-control")).toBe("no-store");
  const first = await queried.json() as SessionBody;
  expect(first.answer).toBe(helloAnswer);
  expect(first.session.pending).toBeNull();
  const [stored] = await production.db.sql`SELECT encrypted_state FROM website_agent_sessions
    WHERE id=${session.id} AND account_id=${actor.accountId}`;
  expect(stored?.encrypted_state).not.toContain(helloPrompt);
  expect(stored?.encrypted_state).not.toContain(helloAnswer);
  expect(String(stored?.encrypted_state).length).toBeGreaterThan(50);

  await production.restart();
  const loaded = await production.request(`${sessionsPath}/${session.id}`, actor);
  expect(loaded.status).toBe(200);
  const restored = await loaded.json() as SessionBody;
  expect(restored.session.id).toBe(session.id);
  expect(restored.session.revision).toBe(first.session.revision);
  expect(restored.session.messages).toEqual(first.session.messages);
  const resumed = await production.request(queryPath, actor, { query: resumePrompt, session_id: session.id,
    expected_revision: restored.session.revision, operation_id: randomUUID(), data_consent: true });
  expect(resumed.status).toBe(200);
  expect((await resumed.json() as SessionBody).answer).toBe(resumeAnswer);
  // The preload only supplies the resume answer when the native provider request contains the old assistant turn.
  expect(await production.providerEvents()).toEqual([{ kind: "hello" }, { kind: "resume" }]);
});

test("hydrated production mobile shell reviews a native digest proposal and commits its exact receipt", async ({ production, page, context }, testInfo) => {
  const actor = await production.member();
  const errors: string[] = [];
  const blockedOrigins: string[] = [];
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  page.on("pageerror", error => errors.push(error.message));
  // Deliberately a manual Cookie header, not a browser-managed Secure cookie.
  // This proves real Next routing/auth/hydration, not HTTPS, TLS or cookie storage policy.
  await context.setExtraHTTPHeaders({ cookie: actor.cookie });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== productionOrigin) {
      blockedOrigins.push(url.origin);
      return route.abort("blockedbyclient");
    }
    if (request.method() === "POST" && url.pathname.startsWith("/api/website-agent/"))
      posts.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
    // No response fulfillment: document, RSC, JS, CSS and API all come from the actual standalone server.
    await route.continue();
  });
  await page.goto(`${productionOrigin}/agent/website`);
  await expect(page.getByRole("heading", { name: "Attention 网页助手", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建会话", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "询问 Attention" })).toBeDisabled();
  const creating = page.waitForResponse(response => new URL(response.url()).pathname === sessionsPath && response.request().method() === "POST");
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  const createResponse = await creating;
  expect(createResponse.status()).toBe(201);
  const created = await createResponse.json() as SessionBody;
  await expect(page).toHaveURL(`${productionOrigin}/agent/website?session=${created.session.id}`);
  await page.getByRole("textbox", { name: "询问 Attention" }).fill(digestPrompt);
  await page.locator('input[name="data_consent"]').check();
  const querying = page.waitForResponse(response => new URL(response.url()).pathname === queryPath);
  await page.getByRole("button", { name: "询问网页助手", exact: true }).click();
  const queryResponse = await querying;
  expect(queryResponse.status()).toBe(200);
  const proposed = await queryResponse.json() as SessionBody;
  expect(proposed.answer).toBe(digestAnswer);
  expect(proposed.session.actions).toHaveLength(1);
  const action = proposed.session.actions![0]!;
  expect(action.status).toBe("pending");
  expect(await production.db.sql`SELECT account_id FROM account_digest_preferences WHERE account_id=${actor.accountId}`).toHaveLength(0);
  const card = page.getByRole("region", { name: "操作确认：更改摘要推送设置", exact: true });
  await expect(card).toContainText(actor.email);
  await expect(card).toContainText("UTC");
  await expect(card).toContainText("09:15");
  await expect(card).toContainText("30");
  await expect(card).toContainText("直到再次更改或停用");
  await expect(card.getByRole("button", { name: "确认执行", exact: true })).toBeDisabled();
  await card.getByRole("checkbox").check();
  const approvalPath = `${sessionsPath}/${created.session.id}/actions/${action.id}/approve`;
  const approving = page.waitForResponse(response => new URL(response.url()).pathname === approvalPath);
  await card.getByRole("button", { name: "确认执行", exact: true }).click();
  const approval = await approving;
  expect(approval.status()).toBe(200);
  const completed = await approval.json() as SessionBody;
  expect(completed.session.actions?.[0]).toMatchObject({ id: action.id, status: "completed", receipt: { ok: true, code: "completed" } });
  expect(posts.filter(post => post.path === approvalPath)).toEqual([{ path: approvalPath, body: {
    expected_revision: proposed.session.revision, expected_arguments_hash: action.argumentsHash, approval: true,
  } }]);
  const [preference] = await production.db.sql`SELECT enabled, timezone, send_window_start_minute,
    send_window_minutes, updated_at FROM account_digest_preferences WHERE account_id=${actor.accountId}`;
  expect(preference).toMatchObject({ enabled: true, timezone: "UTC", send_window_start_minute: 555, send_window_minutes: 30 });
  const eventsBeforeReload = await production.providerEvents();
  expect(eventsBeforeReload.slice(-2)).toEqual([{ kind: "digest_proposal" }, { kind: "digest_review" }]);
  const postCount = posts.length;
  await page.reload();
  await expect(card.getByText("已完成", { exact: true })).toBeVisible();
  await expect(card.getByRole("status")).toHaveText("The exact reviewed action completed.");
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(posts).toHaveLength(postCount);
  expect(await production.providerEvents()).toEqual(eventsBeforeReload);
  const [unchanged] = await production.db.sql`SELECT updated_at FROM account_digest_preferences WHERE account_id=${actor.accountId}`;
  expect(unchanged?.updated_at).toEqual(preference?.updated_at);
  const loaded = await production.request(`${sessionsPath}/${created.session.id}`, actor);
  expect((await loaded.json() as SessionBody).session.actions?.[0]).toMatchObject({ id: action.id, status: "completed" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("production-digest-receipt-mobile-390.png"), fullPage: true });
  await testInfo.attach("acceptance-limits", { body: "Real standalone HTTP, issued synthetic session, native offline provider, hydrated browser and PostgreSQL receipt. Manual Cookie header over loopback HTTP; TLS/Secure-cookie behavior not tested.", contentType: "text/plain" });
  expect(await context.cookies()).toEqual([]);
  expect(blockedOrigins).toEqual([]);
  expect(errors).toEqual([]);
});
