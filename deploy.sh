#!/bin/zsh
# 一键重新部署：构建 + 推送 gh-pages 分支
set -e
cd "$(dirname "$0")"
npm run build
TMP=/tmp/smp-deploy
rm -rf "$TMP"
git clone -q "https://github.com/Cheris0419/sports-meet-plugin.git" "$TMP"
cd "$TMP"
git config user.name "Cheris0419"; git config user.email "cheris0419@users.noreply.github.com"
git checkout -q --orphan gh-pages 2>/dev/null || git checkout -q gh-pages
git rm -rf -q . 2>/dev/null || true
find . -not -path './.git*' -not -name '.' -delete 2>/dev/null || true
cp -R "$(dirname "$0")/dist/" .
git add -A
git commit -q -m "deploy: $(date '+%Y-%m-%d %H:%M')"
git push -q -f origin gh-pages
echo "✅ 已部署: https://cheris0419.github.io/sports-meet-plugin/"
