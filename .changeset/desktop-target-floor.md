---
'@polyrouter/frontend': patch
---

Fixed: five controls were smaller than the 24px minimum hit target at desktop width — the
setup guide's dismiss button, the three setup step buttons, and a routing band-target dropdown.
The 24px floor is required at every width (WCAG 2.5.8 AA) and the stylesheet only applied it to
controls carrying a component class, so anything styled inline had no floor above the narrow
breakpoint. Controls now get the floor by being controls, not by being remembered.
