#!/usr/bin/env bash
# 下载公开样例 PDF 到 test/fixtures/downloaded/（已 gitignore，不入库）。
# 命名规范：real-<来源>-<描述>.pdf —— 与自建夹具 gen-* 区分。
# 全部失败也不影响其余测试：相关用例会自动跳过。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)/downloaded"
mkdir -p "$DIR"

fetch() { # $1=文件名 $2=URL
  local f="$DIR/$1"
  if [ -s "$f" ] && head -c4 "$f" | grep -q "%PDF"; then
    echo "已有 $1"
    return 0
  fi
  echo "下载 $1 ..."
  curl -fsSL --max-time 60 -o "$f" "$2" && echo "  OK ($(wc -c <"$f") bytes)" || {
    echo "  失败：$2"
    rm -f "$f"
    return 1
  }
}

# 清理旧命名残留（历史版本）
rm -f "$DIR/dummy.pdf" "$DIR/somatosensory.pdf" "$DIR/arxiv-attention.pdf"

fetch real-w3c-dummy-1p.pdf "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"
fetch real-css4pub-twocol-4p.pdf "https://css4.pub/2015/textbook/somatosensory.pdf"
fetch real-arxiv-1706.03762-15p.pdf "https://arxiv.org/pdf/1706.03762v7"
