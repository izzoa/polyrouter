---
'@polyrouter/frontend': patch
---

Green status text now meets the WCAG AA contrast floor in light mode. The fill green
used for dots, bars and chip backgrounds is only 2.7:1 on white — fine for a 6px dot,
a failure for the small "OK · served" / "Live" / "free" / "accepted" / "enabled" labels
that also used it. Those labels move to a new darkened `--green-text` token (5.4:1 on
panel, 4.8:1 on the green chip background), while every dot, bar and fill keeps the
original green, so nothing changes visually except that the small green text is now
legible. Dark mode already passed at 8.1:1 and is unchanged.
