---
'naked-eye': minor
---

First release. `extractVisible(html)` returns the text a human would see when an HTML document renders, and `extractVisibleFromPage(page)` from `naked-eye/browser` does the same for a page open in Playwright or Puppeteer. Both report everything they removed and why: CSS-hidden text, text the color of its background, off-screen and clipped boxes, comments, unrendered markup and invisible Unicode, so hidden instructions never reach a model.
