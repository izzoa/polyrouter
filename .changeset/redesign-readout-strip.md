---
'@polyrouter/frontend': patch
---

Overview states the value served on subscription beside spend, and the readout strip ends level

On Overview, when the range holds subscription-backed traffic, a line under the spend figure reads `$3.12 served on subscription, at API rates · excluded from spend`, the same words Costs uses, and the Requests row states its subscription share (`all on subscription plans` or `12 on subscription plans`). With no subscription traffic, neither appears. Spend still means money owed. The readout strip on Overview and Costs now holds the spend cell and, beside it, the other figures as rows (label, figure, qualification) with their figures on one column, so the two sides end level with no blank band under a short figure; at phone width the rows stack under spend. Costs keeps every figure and word. Display only: no API, migration or configuration change.
