#!/usr/bin/env bash
# 抓几个真实页面到 test/real/，用来验证网页段落划分在真实 DOM 上的表现。
#
# 本地样本再怎么造都不如真站点复杂：Wikipedia 一万多个节点、满页 [edit] 链接
# 和公式，MDN 全是代码块。抓下来时注入 <base href> 让原站 CSS 照常加载，
# 这样 getComputedStyle / checkVisibility 的结果才和线上一致。
#
# 抓下来的 HTML 不入库（体积大 + 第三方版权），见 .gitignore。
set -euo pipefail
cd "$(dirname "$0")/../test"
mkdir -p real && cd real

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
PORT="${PORT:-8937}"

grab() {
  local url="$1" name="$2"
  echo "-> $name  $url"
  curl -sSL -A "$UA" -o "$name.raw" "$url" || { echo "   抓取失败，跳过"; return 0; }
  URL="$url" NAME="$name" PORT="$PORT" python3 - <<'PY'
import os, pathlib, re
url, name, port = os.environ['URL'], os.environ['NAME'], os.environ['PORT']
raw = pathlib.Path(f'{name}.raw').read_text(errors='replace')
origin = '/'.join(url.split('/')[:3]) + '/'
probe = f'''
<script src="http://localhost:{port}/src/webblocks.js"></script>
<script>
window.addEventListener('load', () => setTimeout(() => {{
  const t0 = performance.now();
  const units = PBXBlocks.collectUnits(document.body, {{ targetIsCJK: true, skipUI: true }});
  const ms = Math.round(performance.now() - t0);
  const lens = units.map(u => u.text.length).sort((a, b) => a - b);
  window.PROBE = {{
    nodes: document.querySelectorAll('*').length,
    units: units.length, ms, median: lens[lens.length >> 1] || 0,
    withPh: units.filter(u => u.ph.length).length,
    shortest: units.slice().sort((a, b) => a.text.length - b.text.length)
                   .slice(0, 8).map(u => u.text),
    longest: units.slice().sort((a, b) => b.text.length - a.text.length)
                  .slice(0, 3).map(u => u.text.slice(0, 200)),
  }};
  console.log('[PBX]', JSON.stringify(window.PROBE, null, 2));
}}, 800));
</script>
'''
out = re.sub(r'(<head[^>]*>)', r'\1' + f'<base href="{origin}">', raw, count=1, flags=re.I)
out = out.replace('</body>', probe + '</body>') if '</body>' in out else out + probe
pathlib.Path(f'{name}.html').write_text(out)
PY
  rm -f "$name.raw"
}

grab "https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)" wiki
grab "https://arxiv.org/abs/1706.03762" arxiv
grab "https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver" mdn

echo
echo "起服务： python3 -m http.server $PORT --directory .."
echo "然后开   http://localhost:$PORT/test/real/wiki.html"
echo "结果看控制台，或在控制台里敲 window.PROBE"
ls -lh *.html
