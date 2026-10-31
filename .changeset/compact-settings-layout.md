---
'@polyrouter/frontend': patch
---

The Settings page uses the width of the screen

Settings was the only page capped at 760px, so on a wide screen about half of it was empty, and
its four panels stacked in one long column. It now uses the same page width as the other pages.
Above the narrow breakpoint the Instance summary runs across the top as one row (account, mode,
version, endpoint), with Prompt & response bodies on the left beside Notifications and the
Pricing catalog on the right. At phone width the panels stack in the same order.

Controls that choose between a few short options no longer stretch to the width of their panel.
The capture-mode options sit in one row, the Retention select and each agent's override select
take the width of their content, and the agent overrides flow in as many columns as fit instead
of one full-width bar per agent. The retention text beside the select now appears only for
"keep forever", where it adds something; a number of days is no longer printed twice.

No setting, wording or behavior changed, and nothing in the API changed.
