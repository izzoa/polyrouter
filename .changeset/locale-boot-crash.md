---
'@polyrouter/frontend': patch
---

Fixed: the dashboard could fail to load entirely — a blank white page — on hosts whose browser
reports a locale tag that the formatting APIs reject. The charting library builds a number
formatter from the browser's raw reported locale while its module is being loaded, so a
non-conforming tag (`en-US@posix`, as some containers and kiosk browsers report) threw before
the dashboard had rendered anything at all. The reported locale is now checked and, if
unusable, replaced with the one the browser itself resolved for that machine; a host reporting
a normal locale is untouched and formats exactly as before.

Also added: if the dashboard ever fails to start for any reason, it now says so instead of
showing an empty page — a blank page is indistinguishable from a crashed server or a bad
deploy, and sent operators looking in the wrong place.
