---
"@polyrouter/frontend": patch
---

feat(dashboard): the sidebar setup guide can be dismissed

The "Setup guide" card gains an × control; dismissal persists per browser (like the
theme preference), so the card stays gone across reloads. The setup flow itself is
unchanged for anyone who keeps the card.
