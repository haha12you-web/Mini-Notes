// Run against the local Vite server:
// playwright-cli run-code --filename tests/browser-toggle-editing.cjs --raw
async (originalPage) => {
  const context = await originalPage.context().browser().newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  });
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const block = (id, type, text, children = []) => ({
    id, type, props: {}, content: [{ type: "text", text, styles: {} }], children
  });
  const titleSelector = (id) => `.bn-block[data-id="${id}"] > .bn-block-content .bn-inline-content`;
  const toggleSelector = '.bn-block[data-id="toggle"] > .bn-block-content .bn-toggle-button';
  const checks = [];

  async function withNote(title, children, expanded, run) {
    const page = await context.newPage();
    const user = { id: "toggle-edit-user", username: "toggle-edit-test", isAdmin: false };
    const note = {
      id: "toggle-edit-note", title: "Toggle editing", icon: "📝", kind: "page", titleSize: "h1",
      titleSegments: [{ text: "Toggle editing", color: "default" }], parentId: null,
      isArchived: false, shareToken: null, sharedAt: null, sortOrder: 1,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      content: [block("intro", "paragraph", "Previous paragraph"),
        block("toggle", "toggleListItem", title, children), block("after", "paragraph", "After paragraph")]
    };
    const saves = [];
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const send = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
      if (path === "/api/status") return send({ authenticated: true, hasUsers: true, user });
      if (path === "/api/notes") return send([note]);
      if (path === `/api/notes/${note.id}`) {
        if (request.method() === "PATCH") {
          const patch = request.postDataJSON();
          saves.push(patch);
          Object.assign(note, patch, { updatedAt: new Date().toISOString() });
        }
        return send(note);
      }
      return send({ error: `Unhandled fixture: ${path}` }, 404);
    });
    await page.addInitScript((expanded) => {
      localStorage.clear();
      localStorage.setItem("toggle-toggle", String(expanded));
    }, expanded);
    try {
      await page.goto("http://127.0.0.1:5173/");
      await page.locator(toggleSelector).waitFor();
      await run(page, note, saves);
    } finally {
      await page.close();
    }
  }

  async function snapshot(page) {
    return page.evaluate(() => {
      const view = document.querySelector(".bn-editor").editor.view;
      const read = (node) => ({
        id: node.attrs.id, type: node.firstChild.type.name, text: node.firstChild.textContent,
        children: node.childCount > 1 ? Array.from({ length: node.child(1).childCount }, (_, i) => read(node.child(1).child(i))) : []
      });
      return Array.from({ length: view.state.doc.firstChild.childCount }, (_, i) => read(view.state.doc.firstChild.child(i)));
    });
  }

  async function selectTitle(page, id = "toggle", all = false) {
    await page.locator(titleSelector(id)).evaluate((title, all) => {
      document.querySelector(".bn-editor").focus();
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(title);
      if (!all) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }, all);
    // Let ProseMirror receive the native selection before mutating the DOM.
    await page.waitForTimeout(50);
  }

  async function nativeEdit(page, command, value) {
    const applied = await page.evaluate(({ command, value }) => document.execCommand(command, false, value), { command, value });
    assert(applied, `native ${command} did not run`);
    // Native input is reconciled asynchronously by ProseMirror's DOM observer.
    await page.waitForTimeout(180);
  }

  async function assertTitle(page, expected, originalChildren, expanded) {
    const doc = await snapshot(page);
    assert(doc.map((item) => item.id).join(",") === "intro,toggle,after", `unexpected blocks: ${JSON.stringify(doc)}`);
    assert(doc[1].type === "toggleListItem" && doc[1].text === expected, `wrong title: ${JSON.stringify(doc[1])}`);
    assert(doc[0].text === "Previous paragraph" && doc[2].text === "After paragraph", "adjacent paragraphs changed");
    assert(JSON.stringify(doc[1].children) === JSON.stringify(originalChildren), "toggle body changed");
    const state = await page.locator(toggleSelector).evaluate((button) => {
      const title = button.parentElement.querySelector(".bn-inline-content");
      return {
        expanded: button.parentElement.getAttribute("data-show-children"),
        cursorInTitle: title.contains(getSelection()?.anchorNode)
      };
    });
    assert(state.expanded === String(expanded), "expanded state changed while editing");
    assert(state.cursorInTitle, "cursor left the original toggle title");
  }

  try {
    await withNote("6", [], true, async (page, note, saves) => {
      await selectTitle(page);
      // Keyboard.press('Backspace') misses the Android DOM-mutation path.
      // execCommand triggers Chromium's real native deletion and wrapper cleanup.
      await nativeEdit(page, "delete");
      await assertTitle(page, "", [], true);
      await nativeEdit(page, "insertText", "核心内容");
      await assertTitle(page, "核心内容", [], true);
      await selectTitle(page, "toggle", true);
      await nativeEdit(page, "delete");
      await assertTitle(page, "", [], true);

      // Empty-title serialization must keep the same block, including on reload.
      for (let attempt = 0; attempt < 40 && !(saves.length && note.content[1].content.length === 0); attempt++) {
        await page.waitForTimeout(100);
      }
      assert(saves.length && note.content.length === 3 && note.content[1].id === "toggle" && note.content[1].content.length === 0,
        "empty title was not saved as the original toggle");
      await page.reload();
      await page.locator(toggleSelector).waitFor();
      const reloaded = await snapshot(page);
      assert(reloaded.length === 3 && reloaded[1].id === "toggle" && reloaded[1].text === "", "empty title did not survive reload");

      // Controls must remain usable after Chrome has reparented wrapper nodes.
      await selectTitle(page);
      await nativeEdit(page, "insertText", "6");
      await nativeEdit(page, "delete");
      const add = page.locator('.bn-block[data-id="toggle"] > .bn-block-content .bn-toggle-add-block-button');
      assert(await add.isVisible(), "empty expanded toggle lost its add-body button");
      await page.locator(toggleSelector).click();
      assert(!(await add.isVisible()), "add-body button stayed visible after collapsing");
      await page.locator(toggleSelector).click();
      assert(await add.isVisible(), "add-body button disappeared after reopening");
      await add.click();
      const doc = await snapshot(page);
      assert(doc.length === 3 && doc[1].children.length === 1, "add-body button did not create exactly one child");
      await nativeEdit(page, "insertText", "正文");
      assert((await snapshot(page))[1].children[0].text === "正文", "cannot type in the new child body");
      checks.push("single-character deletion, retyping, save/reload, collapse/reopen and add body");
    });

    const children = [block("body", "paragraph", "原来的正文"),
      block("nested", "toggleListItem", "内层标题", [block("nested-body", "paragraph", "内层正文")])];
    for (const expanded of [false, true]) {
      await withNote("核心内容", children, expanded, async (page) => {
        const originalChildren = (await snapshot(page))[1].children;
        await selectTitle(page);
        for (const expected of ["核心内", "核心", "核", ""]) {
          await nativeEdit(page, "delete");
          await assertTitle(page, expected, originalChildren, expanded);
        }
        await nativeEdit(page, "insertText", "修改后的标题");
        await assertTitle(page, "修改后的标题", originalChildren, expanded);
        await selectTitle(page, "toggle", true);
        await nativeEdit(page, "delete");
        await assertTitle(page, "", originalChildren, expanded);
        if (!expanded) await page.locator(toggleSelector).click();
        await selectTitle(page, "body");
        await nativeEdit(page, "insertText", "继续写");
        const doc = await snapshot(page);
        assert(doc[1].children[0].text === "原来的正文继续写", "existing body cannot be edited after clearing title");
        assert(JSON.stringify(doc[1].children[1]) === JSON.stringify(originalChildren[1]), "nested toggle was altered");
        checks.push(`${expanded ? "expanded" : "collapsed"} Chinese deletion, select/delete, nested body preservation`);
      });
    }

    await withNote("核心内容", [], false, async (page) => {
      await selectTitle(page, "toggle", true);
      await nativeEdit(page, "delete");
      await assertTitle(page, "", [], false);
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(180);
      await assertTitle(page, "核心内容", [], false);
      await page.keyboard.press("Control+Shift+z");
      await page.waitForTimeout(180);
      await assertTitle(page, "", [], false);
      await nativeEdit(page, "insertText", "恢复输入");
      await assertTitle(page, "恢复输入", [], false);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(180);
      const doc = await snapshot(page);
      assert(doc.length === 4 && doc[1].text === "恢复输入" && doc[2].type === "toggleListItem" && doc[2].text === "", "real Enter no longer creates the next toggle");
      checks.push("select/delete while collapsed, undo/redo and real Enter");
    });
    return { result: "passed", environment: "Chromium with Android UA and native DOM editing", checks };
  } finally {
    await context.close();
  }
}
