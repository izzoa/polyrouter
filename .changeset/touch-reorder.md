---
'@polyrouter/frontend': minor
---

Tier chains can now be reordered on a touch device, and the chain row is readable on a
phone at all.

Reordering was wired to HTML5 drag-and-drop, which browsers never fire for touch input. So
on a phone the Routing page rendered, invited interaction, and could not perform its
function: the fallback order was fixed at whatever it was when it was created. The only
other path was `Alt`+arrow on the drag handle, needing a physical keyboard and discoverable
only by reading the handle's label.

Each chain row now carries explicit move-up / move-down controls, disabled at the ends of
the chain. They share the mover with the keyboard path rather than reimplementing it, so
the three transports cannot drift apart — a test reorders the same chain by drag, by
keyboard and by tap and asserts all three persist an identical result. They appear where a
drag is unavailable: below the narrow threshold, or wherever *any* available pointer is
coarse. That second condition matters more than it looks, because a laptop with a mouse and
a touchscreen reports a fine pointer while being exactly the device that cannot drag with a
finger.

The row itself was also broken, which measuring it turned up. At 320px it had 194px of
content width and put 253px in it: the model identifier — the name of the thing being
reordered — computed to **zero width**, the price label was painted on top of it, and the
row's action was clipped off the edge. None of that registered as document overflow, which
is why it had gone unnoticed. The row now separates its information from its actions and
wraps, so the identifier is legible and every control is reachable. The header hint stops
telling touch users to drag.

**Desktop rendering is unchanged** — same single-line row, same controls, no move buttons —
pinned against geometry captured before the work began.
