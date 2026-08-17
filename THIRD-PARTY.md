# 第三方组件

`lib/` 下面是 vendored 的 [pdf.js](https://github.com/mozilla/pdf.js)
（npm 包 `pdfjs-dist`，版本 **4.10.38**），由 Mozilla 以 **Apache License 2.0**
发布，版权归 Mozilla Foundation 及贡献者所有。

包含：`pdf.mjs`、`pdf.worker.mjs`、`cmaps/`（CJK 字符映射）、`standard_fonts/`。

许可证全文：https://github.com/mozilla/pdf.js/blob/master/LICENSE

更新版本用 `tools/fetch-pdfjs.sh`。
