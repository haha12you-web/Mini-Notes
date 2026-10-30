// Run against the local Vite server with:
// playwright-cli run-code --filename tests/browser-toggle-list.cjs
async (page) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const user = { id: "toggle-test-user", username: "toggle-test", isAdmin: false };
  const note = {
    id: "mobile-toggle-note",
    title: "Toggle list test",
    icon: "📝",
    kind: "page",
    titleSize: "h1",
    titleSegments: [{ text: "Toggle list test", color: "default" }],
    parentId: null,
    isArchived: false,
    shareToken: null,
    sharedAt: null,
    sortOrder: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    content: [
      {
        id: "toggle-parent",
        type: "toggleListItem",
        props: {},
        content: [{ type: "text", text: "Fold parent with a long title 长标题与连续字符ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", styles: {} }],
        children: [
          {
            id: "toggle-child",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "Nested child", styles: {} }],
            children: []
          }
        ]
      }
    ]
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const send = (data, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data)
    });
    if (path === "/api/status") return send({ authenticated: true, hasUsers: true, user });
    if (path === "/api/notes") return send([note]);
    if (path === `/api/notes/${note.id}`) return send(note);
    return send({ error: `Unhandled fixture: ${path}` }, 404);
  });

  await page.addInitScript(() => localStorage.removeItem("toggle-toggle-parent"));
  await page.goto("http://127.0.0.1:5173/");
  const toggle = page.locator(".note-editor .bn-toggle-button").first();
  await toggle.waitFor();
  const child = page.getByText("Nested child", { exact: true });
  await child.waitFor({ state: "attached" });
  if (await child.isVisible()) throw new Error("child list should start collapsed");
  const initial = await toggle.evaluate((button) => ({
    width: button.getBoundingClientRect().width,
    height: button.getBoundingClientRect().height,
    expanded: button.parentElement.getAttribute("data-show-children")
  }));
  if (initial.width < 43.9 || initial.height < 43.9) {
    throw new Error(`mobile toggle target is too small: ${initial.width}x${initial.height}`);
  }
  if (initial.expanded !== "false") {
    throw new Error(`initial collapsed state is incorrect: ${JSON.stringify(initial)}`);
  }

  await toggle.click();
  await page.waitForFunction(() => {
    const button = document.querySelector(".note-editor .bn-toggle-button");
    return button?.parentElement.getAttribute("data-show-children") === "true";
  });
  await child.waitFor({ state: "visible" });
  const expanded = await toggle.evaluate((button) => {
    const children = button.closest(".bn-block").querySelector(":scope > .bn-block-group");
    return children && getComputedStyle(children).display !== "none";
  });
  if (!expanded) throw new Error("child list did not expand");

  await toggle.click();
  await page.waitForFunction(() => {
    const button = document.querySelector(".note-editor .bn-toggle-button");
    return button?.parentElement.getAttribute("data-show-children") === "false";
  });
  const collapsed = await toggle.evaluate((button) => {
    const children = button.closest(".bn-block").querySelector(":scope > .bn-block-group");
    return children && getComputedStyle(children).display === "none";
  });
  if (!collapsed) throw new Error("child list did not collapse");

  for (const width of [320, 390, 760, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await toggle.click();
    await child.waitFor({ state: "visible" });
    const layout = await toggle.evaluate((button) => {
      const wrapper = button.parentElement;
      const text = wrapper.querySelector(".bn-inline-content");
      return {
        wrapperWidth: wrapper.clientWidth,
        scrollWidth: wrapper.scrollWidth,
        textWidth: text.clientWidth,
        indent: getComputedStyle(button.closest(".bn-block").querySelector(":scope > .bn-block-group")).marginLeft
      };
    });
    if (layout.scrollWidth > layout.wrapperWidth + 1 || layout.textWidth < 100) {
      throw new Error(`title overflows at ${width}px: ${JSON.stringify(layout)}`);
    }
    if (width <= 760 && layout.indent !== "18px") {
      throw new Error(`wrong mobile indent at ${width}px: ${layout.indent}`);
    }
    await toggle.click();
    await child.waitFor({ state: "hidden" });
  }
  return { result: "passed", mobileTarget: `${initial.width}x${initial.height}`, checks: ["44px touch target", "initial collapsed state", "expand children", "collapse children", "long titles at 320/390/760/1280px", "18px mobile nesting"] };
}
