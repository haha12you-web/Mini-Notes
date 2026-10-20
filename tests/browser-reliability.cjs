// Run against the local Vite server with:
// playwright-cli -s=mini-notes-recovery run-code --filename tests/browser-reliability.cjs
async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unroute("**/api/**");
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => dialog.accept());
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const user = { id: "browser-test-user", username: "recovery-test", isAdmin: false };
  const makeNote = (id, title) => ({ id, title, icon: "📝", kind: "page", titleSize: "h1",
    titleSegments: [{ text: title, color: "default" }], parentId: null, sortOrder: 1,
    isArchived: false, shareToken: null, sharedAt: null, content: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  const notes = [makeNote("browser-note-one", "First page"), makeNote("browser-note-two", "Recovery page")];
  let failed = true;
  let attempts = [];
  let holdNextSave = false;
  let releaseSave = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const send = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/api/status") return send({ authenticated: true, hasUsers: true, user });
    if (path === "/api/notes") return send(notes);
    const note = notes.find((item) => path === `/api/notes/${item.id}`);
    if (note && request.method() === "GET") return send(note);
    if (note && request.method() === "PATCH") {
      const patch = request.postDataJSON();
      attempts.push(patch);
      if (failed) return send({ error: "Synthetic temporary failure" }, 503);
      if (patch.expectedUpdatedAt !== note.updatedAt) return send({ error: "Version changed" }, 409);
      if (holdNextSave) {
        holdNextSave = false;
        await new Promise((resolve) => { releaseSave = resolve; });
      }
      Object.assign(note, patch, { updatedAt: new Date().toISOString() });
      return send(note);
    }
    return send({ error: `Unhandled fixture: ${path}` }, 404);
  });
  // Start recovery on a page that is not first in the list.
  await page.goto("http://127.0.0.1:5173");
  await page.evaluate(({ user, note }) => {
    localStorage.clear();
    const key = `mini-notes:draft:v1:${user.id}:`;
    const local = { ...note, title: "Recovered local title", titleSegments: [{ text: "Recovered local title", color: "default" }] };
    localStorage.setItem(`${key}${note.id}`, JSON.stringify({ token: "fixture", note: local, savedAt: new Date().toISOString() }));
    localStorage.setItem(`${key}last`, note.id);
  }, { user, note: notes[1] });
  await page.reload();
  const title = page.getByRole("textbox", { name: "页面标题", exact: true });
  await title.filter({ hasText: "Recovered local title" }).waitFor();
  await page.getByText("Synthetic temporary failure", { exact: true }).waitFor();
  assert(await page.getByText("本地已备份，待同步", { exact: true }).isVisible(), "local backup status missing");
  await page.waitForTimeout(18000);
  assert(attempts.length === 4, `expected initial save plus three bounded retries, got ${attempts.length}`);
  await title.fill("Newer local title");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("mini-notes:draft:v1:browser-test-user:browser-note-two")).note.title === "Newer local title");
  await page.reload();
  await title.filter({ hasText: "Newer local title" }).waitFor();
  failed = false;
  await page.getByRole("button", { name: "立即重试", exact: true }).click();
  await page.getByText("已保存", { exact: true }).waitFor();
  assert(notes[1].title === "Newer local title", "retry did not save newest revision");
  assert(!("content" in attempts.at(-1)), "title-only save unnecessarily sent content");
  assert(await page.evaluate(() => localStorage.getItem("mini-notes:draft:v1:browser-test-user:browser-note-two")) === null, "acknowledged draft not cleared");
  // A remote update must suspend autosave and require a deliberate choice.
  notes[1].updatedAt = "2026-10-20T12:00:00.000Z";
  await page.evaluate(({ user, note }) => {
    const key = `mini-notes:draft:v1:${user.id}:`;
    const local = { ...note, updatedAt: "2026-01-01T00:00:00.000Z", title: "Conflicting local title", titleSegments: [{ text: "Conflicting local title", color: "default" }] };
    localStorage.setItem(`${key}${note.id}`, JSON.stringify({ token: "conflict", note: local, savedAt: new Date().toISOString() }));
    localStorage.setItem(`${key}last`, note.id);
  }, { user, note: notes[1] });
  const countBeforeConflict = attempts.length;
  await page.reload();
  await page.getByRole("button", { name: "保留本地版本", exact: true }).waitFor();
  await title.filter({ hasText: "Conflicting local title" }).waitFor();
  await page.waitForTimeout(1800);
  assert(attempts.length === countBeforeConflict, "conflict was automatically overwritten");
  await page.reload();
  await page.getByRole("button", { name: "保留本地版本", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "output/playwright/conflict-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "使用云端版本", exact: true }).click();
  await title.filter({ hasText: "Newer local title" }).waitFor();
  assert(await page.evaluate(() => localStorage.getItem("mini-notes:draft:v1:browser-test-user:browser-note-two")) === null, "discard did not clear conflict draft");
  await page.setViewportSize({ width: 1280, height: 900 });
  // A response for an older revision must rebase, not erase, a newer draft.
  holdNextSave = true;
  await title.fill("Pending title");
  for (let count = 0; !releaseSave && count < 100; count++) await page.waitForTimeout(50);
  assert(releaseSave, "delayed save did not begin");
  await title.fill("Latest while pending");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("mini-notes:draft:v1:browser-test-user:browser-note-two")).note.title === "Latest while pending");
  releaseSave();
  await page.getByText("已保存", { exact: true }).waitFor();
  assert(notes[1].title === "Latest while pending", "old response replaced the newer revision");
  assert(await page.evaluate(() => localStorage.getItem("mini-notes:draft:v1:browser-test-user:browser-note-two")) === null, "latest acknowledged draft not cleared");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await title.filter({ hasText: "Latest while pending" }).waitFor();
  await page.screenshot({ path: "output/playwright/recovery-mobile.png", fullPage: true });
  return { result: "passed", saveRequests: attempts.length, checks: ["recovery on non-first page", "503 backup", "bounded retries", "reload recovery", "latest retry", "metadata-only patch", "conflict held across reload", "explicit cloud version choice", "new edits during a pending save"] };
}
