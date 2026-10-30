import { defaultBlockSpecs } from "@blocknote/core";

const defaultToggleListItem = defaultBlockSpecs.toggleListItem;

export const toggleListItem: typeof defaultToggleListItem = {
  ...defaultToggleListItem,
  implementation: {
    ...defaultToggleListItem.implementation,
    render(block, editor) {
      const nodeView = defaultToggleListItem.implementation.render.call(this, block, editor);
      const toggleContainer = nodeView.dom.querySelector(".bn-toggle-wrapper")?.parentElement;
      // Chrome unwraps anonymous divs when native deletion empties the title.
      // Give this UI container an identity so it survives that cleanup: moving
      // its children triggers ProseMirror's Android Enter heuristic and leaves
      // the toggle controls referencing a detached container.
      toggleContainer?.classList.add("bn-toggle-content");

      return nodeView;
    }
  }
};
