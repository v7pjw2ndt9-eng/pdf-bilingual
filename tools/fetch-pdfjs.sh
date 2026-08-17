#!/usr/bin/env bash
# 更新 lib/ 下面 vendored 的 pdf.js。默认版本见下方 VERSION。
set -euo pipefail
VERSION="${1:-4.10.38}"
cd "$(dirname "$0")/.."

echo "抓取 pdfjs-dist@$VERSION"
curl -sSL -o "lib/pdf.mjs"        "https://cdn.jsdelivr.net/npm/pdfjs-dist@$VERSION/build/pdf.min.mjs"
curl -sSL -o "lib/pdf.worker.mjs" "https://cdn.jsdelivr.net/npm/pdfjs-dist@$VERSION/build/pdf.worker.min.mjs"

tmp="$(mktemp -d)"
curl -sSL -o "$tmp/p.tgz" "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-$VERSION.tgz"
tar -xzf "$tmp/p.tgz" -C "$tmp" package/cmaps package/standard_fonts
rm -rf lib/cmaps lib/standard_fonts
mv "$tmp/package/cmaps" "$tmp/package/standard_fonts" lib/
rm -rf "$tmp"

du -sh lib/*
