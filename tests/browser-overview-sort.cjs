// Run against pnpm dev with:
// playwright-cli -s=mini-notes-sort run-code --filename tests/browser-overview-sort.cjs
async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const user = { id: "overview-sort-test", username: "sort-test", isAdmin: false };
  const makeRecord = (id, kind, sortOrder, parentId = null) => ({
    id, kind, title: `${kind === "category" ? "分类" : "页面"} ${id}`, icon: "📝", parentId,
    titleSize: "h1", titleSegments: [], sortOrder, isArchived: false, shareToken: null,
    sharedAt: null, content: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  });
  const records = Array.from({ length: 13 }, (_, i) => makeRecord(`folder-${i}`, "category", 100000 - i * 1000));
  records.push(makeRecord("page-one", "page", 85000), makeRecord("page-two", "page", 84000));
  records.push(makeRecord("child-one", "page", 3000, "folder-0"), makeRecord("child-two", "category", 2000, "folder-0"));
  let rejectMove = false;
  const moves = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.unroute("**/api/**");
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/status") return send({ authenticated: true, hasUsers: true, user });
    if (path === "/api/notes") return send(records);
    const moving = records.find((record) => path === `/api/notes/${record.id}/move`);
    if (moving) {
      const input = request.postDataJSON();
      moves.push({ id: moving.id, ...input });
      if (rejectMove) return send({ error: "排序保存失败测试" }, 503);
      const previousParentId = moving.parentId;
      Object.assign(moving, input, { updatedAt: new Date().toISOString() });
      return send({ ...moving, previousParentId });
    }
    const record = records.find((item) => path === `/api/notes/${item.id}`);
    if (record) return send(record);
    return send({ error: `Unhandled fixture: ${path}` }, 404);
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto("http://127.0.0.1:5173");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const home = async () => {
    await page.getByTitle("返回笔记首页", { exact: true }).click();
    await page.getByRole("heading", { name: "笔记首页", exact: true }).waitFor();
  };
  await home();
  const ids = () => page.locator("[data-overview-record-id]").evaluateAll((cards) => cards.map((card) => card.dataset.overviewRecordId));
  const card = (id) => page.locator(`[data-overview-record-id="${id}"]`);
  const handle = (id) => card(id).getByRole("button", { name: /^调整顺序/ });
  const waitForFirst = (id) => page.waitForFunction((expected) => document.querySelector("[data-overview-record-id]")?.dataset.overviewRecordId === expected, id);
  const drag = async (from, to, after = false, cancel = false) => {
    const source = await handle(from).boundingBox();
    const target = await card(to).boundingBox();
    assert(source && target, "missing drag source or destination");
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width * (after ? 0.8 : 0.2), target.y + target.height / 2, { steps: 16 });
    await page.locator(".notes-overview-card.is-dragging").waitFor();
    await page.locator(after ? ".notes-overview-card.sort-after" : ".notes-overview-card.sort-before").waitFor();
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
  };

  // Cross-row movement supports categories and pages in one shared order.
  await drag("page-two", "folder-0");
  await waitForFirst("page-two");
  assert(moves.at(-1).id === "page-two" && moves.at(-1).parentId === null, "drag changed parent or did not save");
  await page.reload();
  await home();
  await waitForFirst("page-two");
  assert((await ids())[1] === "folder-0", "saved order did not survive reload");

  const beforeCancel = await ids();
  const requestsBeforeCancel = moves.length;
  await drag("folder-5", "folder-0", false, true);
  assert(JSON.stringify(await ids()) === JSON.stringify(beforeCancel), "Escape changed the order");
  assert(moves.length === requestsBeforeCancel, "cancelled drag sent a request");

  // Keyboard movement keeps focus and permits moving to either end.
  await handle("folder-4").focus();
  await page.keyboard.press("Home");
  await waitForFirst("folder-4");
  assert(await handle("folder-4").evaluate((element) => element === document.activeElement), "reorder lost keyboard focus");
  await page.keyboard.press("End");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-overview-record-id]")].at(-1)?.dataset.overviewRecordId === "folder-4");

  // Server failures must restore the authoritative order.
  rejectMove = true;
  const beforeFailure = await ids();
  await handle("folder-7").focus();
  await page.keyboard.press("Home");
  await page.getByText("排序保存失败测试", { exact: true }).waitFor();
  await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll("[data-overview-record-id]")].map((element) => element.dataset.overviewRecordId)) === JSON.stringify(expected), beforeFailure);
  rejectMove = false;

  // A folder uses the same component, without changing its children to root items.
  await card("folder-0").getByRole("button").first().click();
  await page.getByRole("heading", { name: "分类 folder-0", exact: true }).waitFor();
  assert((await ids()).length === 2, "folder did not show its own children");
  await handle("child-two").focus();
  await page.keyboard.press("Home");
  await waitForFirst("child-two");
  assert(moves.at(-1).parentId === "folder-0", "folder sort escaped its parent");
  await home();
  await page.screenshot({ path: "output/playwright/overview-sort-desktop.png", fullPage: true });

  // Real touch pointer events exercise pointer capture in a mobile browser context.
  const mobile = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage();
  await mobilePage.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const send = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/status") return send({ authenticated: true, hasUsers: true, user });
    if (path === "/api/notes") return send(records);
    const moving = records.find((record) => path === `/api/notes/${record.id}/move`);
    if (moving) {
      const previousParentId = moving.parentId;
      Object.assign(moving, route.request().postDataJSON(), { updatedAt: new Date().toISOString() });
      return send({ ...moving, previousParentId });
    }
    return send(records.find((record) => path === `/api/notes/${record.id}`) ?? {});
  });
  await mobilePage.goto("http://127.0.0.1:5173");
  mobilePage.on("pageerror", (error) => errors.push(error.message));
  await mobilePage.getByTitle("返回笔记首页", { exact: true }).click();
  await mobilePage.getByRole("heading", { name: "笔记首页", exact: true }).waitFor();
  const mobileCards = mobilePage.locator("[data-overview-record-id]");
  const mobileIds = await mobileCards.evaluateAll((cards) => cards.map((element) => element.dataset.overviewRecordId));
  const touchSource = await mobileCards.nth(2).getByRole("button", { name: /^调整顺序/ }).boundingBox();
  const touchTarget = await mobileCards.first().boundingBox();
  assert(touchSource && touchTarget, "missing mobile drag targets");
  const cdp = await mobile.newCDPSession(mobilePage);
  const sourcePoint = { x: touchSource.x + touchSource.width / 2, y: touchSource.y + touchSource.height / 2 };
  const targetPoint = { x: touchTarget.x + touchTarget.width / 2, y: touchTarget.y + 8 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [sourcePoint] });
  for (let step = 1; step <= 12; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: sourcePoint.x + (targetPoint.x - sourcePoint.x) * step / 12, y: sourcePoint.y + (targetPoint.y - sourcePoint.y) * step / 12 }] });
  }
  const marker = mobilePage.locator(".notes-overview-card.sort-horizontal.sort-before");
  assert(await marker.count() === 1, "single-column drag did not show a horizontal insertion marker");
  assert(await marker.evaluate((element) => getComputedStyle(element, "::before").height === "3px"), "mobile insertion marker has the wrong direction");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await mobilePage.waitForFunction((id) => document.querySelector("[data-overview-record-id]")?.dataset.overviewRecordId === id, mobileIds[2]);
  assert(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile layout overflows");
  await mobilePage.screenshot({ path: "output/playwright/overview-sort-mobile.png", fullPage: true });
  await mobile.close();
  assert(errors.length === 0, `browser errors: ${errors.join("; ")}`);
  return { result: "passed", savedMoves: moves.length, checks: ["cross-row drag", "mixed page/category order", "reload persistence", "Escape cancellation", "keyboard endpoints and focus", "failure rollback", "folder child isolation", "real mobile touch drag", "mobile overflow", "no browser errors"] };
}
