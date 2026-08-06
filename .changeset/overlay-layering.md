---
'@polyrouter/frontend': patch
---

Fixed: the two body-capture confirmation dialogs — "Capture prompt & response bodies?" and
"Turn capture off" — announced themselves to assistive technology as modal dialogs while
implementing none of it. Keyboard focus could Tab straight out of them into the page behind,
and Escape did not close them, even though `aria-modal` told a screen reader the rest of the
page was hidden. Both now trap focus, close on Escape, and return focus to the control that
opened them.

Changed: the account menu now closes when you press Tab, letting focus continue into the
page, which matches how menus are expected to behave. Previously Tab moved focus through the
page behind while the menu stayed open.

Under both: overlay layering is now decided in one place. Which surface takes Escape, which
one traps Tab, and which one paints on top all derive from a single ordering, so they cannot
disagree — they previously could, and did.
