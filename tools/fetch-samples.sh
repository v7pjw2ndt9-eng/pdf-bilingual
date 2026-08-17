#!/usr/bin/env bash
# 取回测试台用的样本 PDF。这些文件不入库（体积大 + 第三方版权）。
set -euo pipefail
cd "$(dirname "$0")/../test"

get() { echo "-> $2"; curl -sSL -A "Mozilla/5.0" -o "$2" "$1"; }

get "https://arxiv.org/pdf/1810.04805v2"  two-col.pdf     # BERT, ACL 双栏
get "https://arxiv.org/pdf/1706.03762v7"  one-col.pdf     # Transformer, NIPS 单栏
get "https://www.biorxiv.org/content/10.1101/2025.10.01.679862v2.full.pdf" user-paper.pdf  # bioRxiv 带行号稿件

ls -lh *.pdf
