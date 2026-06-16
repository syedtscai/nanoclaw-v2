---
name: doc-extract
description: Read attachments — Office docs (pptx/docx/xlsx), PDFs, HTML, CSV/JSON, and images — by converting them to text. Use whenever you need to read the CONTENTS of a file or URL that isn't already plain text (a Slack/Gmail attachment, a file in your inbox, a downloaded document, or a public web page).
allowed-tools: Bash(markitdown:*), Bash(tesseract:*), Bash(curl:*), Bash(mkdir:*), Bash(rm:*), Read
---

# Reading attachments and documents

Two local CLIs are installed in your container. Both are free, fast, and run
offline — no tokens, no external calls beyond fetching the file itself.

- **`markitdown`** — converts Office / PDF / HTML / CSV / JSON to Markdown.
- **`tesseract`** — OCRs text out of images (for agents without vision).

Always work in a scratch dir: `mkdir -p /workspace/agent/tmp`. Delete temp
files when you're done extracting facts.

## Office, PDF, HTML, CSV, JSON → Markdown

```bash
markitdown /path/to/file.pptx -o /workspace/agent/tmp/out.md
```

Then `Read` `/workspace/agent/tmp/out.md`. Supported extensions:
`.pptx .docx .xlsx .xls .pdf .html .htm .csv .json .xml .epub .zip`
(`.txt`/`.md`/`.csv`/`.json` you can also just `Read` directly).

`markitdown` reads **local files only** — it does not take http URLs. For a web
page, download it first (see below).

## Images → text (OCR)

If you are **not vision-capable** (e.g. Iris on DeepSeek flash), OCR the image:

```bash
tesseract /path/to/image.png stdout
```

- If OCR returns useful text (a screenshot of a sheet, slide, doc, or chat),
  use it and extract facts as normal.
- If OCR returns little or nothing, it's a true photo/diagram — **do not guess**.
  Log it and flag it as "image attachment, unread" so a vision-capable agent
  (Zora / Mr. S) can review on demand.

If you **are** vision-capable (e.g. Zora on Claude), just `Read` the image
directly — no OCR needed.

## Public URLs

`markitdown` has no URL fetcher, so download then convert. `curl` honors the
OneCLI gateway proxy automatically (auth injected for known hosts):

```bash
curl -sSL "https://example.com/report" -o /workspace/agent/tmp/page.html
markitdown /workspace/agent/tmp/page.html -o /workspace/agent/tmp/page.md
```

For JavaScript-heavy or login-gated pages where `curl` returns an empty shell,
use the **agent-browser** skill instead (it drives a real Chromium).

## Cleanup

```bash
rm -f /workspace/agent/tmp/*
```
