#!/bin/bash
# =====================================================
# 三重県北部不動産推薦アプリ - GitHub Pagesデプロイスクリプト
# =====================================================
#
# 使い方:
#   1. GitHubでPersonal Access Token (PAT)を作成:
#      https://github.com/settings/tokens/new
#      必要なスコープ: repo (Full control of private repositories)
#
#   2. このスクリプトを実行:
#      bash deploy-to-github.sh YOUR_GITHUB_TOKEN YOUR_GITHUB_USERNAME
#
#   3. 完了後、以下のURLでアクセス可能:
#      https://YOUR_USERNAME.github.io/mie-realestate-app/
#
# 既存リポジトリがある場合は自動的にファイルを更新します。
# =====================================================

set -e

TOKEN="${1:?Usage: bash deploy-to-github.sh <GITHUB_TOKEN> <GITHUB_USERNAME>}"
USERNAME="${2:?Usage: bash deploy-to-github.sh <GITHUB_TOKEN> <GITHUB_USERNAME>}"
REPO_NAME="mie-realestate-app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HTML_FILE="$SCRIPT_DIR/index.html"

if [ ! -f "$HTML_FILE" ]; then
  echo "Error: $HTML_FILE not found"
  exit 1
fi

echo "=== Step 1: リポジトリ確認/作成 ==="
REPO_CHECK=$(curl -s -o /dev/null -w "%{http_code}" \
  "https://api.github.com/repos/$USERNAME/$REPO_NAME" \
  -H "Authorization: token $TOKEN")

if [ "$REPO_CHECK" = "200" ]; then
  echo "リポジトリが既に存在します。ファイルを更新します。"
else
  echo "新規リポジトリを作成します..."
  curl -s -X POST "https://api.github.com/user/repos" \
    -H "Authorization: token $TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    -d "{\"name\":\"$REPO_NAME\",\"description\":\"三重県北部 不動産推薦アプリ\",\"homepage\":\"https://$USERNAME.github.io/$REPO_NAME/\",\"auto_init\":false,\"private\":false}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Created: {d.get(\"html_url\", d.get(\"message\", \"error\"))}')"
  sleep 2
fi

echo ""
echo "=== Step 2: ファイルをプッシュ ==="

# デプロイ対象ファイル一覧
DEPLOY_FILES=("index.html" "school-districts.geojson")

push_file() {
  local FILE_PATH="$1"
  local FILE_NAME="$(basename "$FILE_PATH")"

  if [ ! -f "$FILE_PATH" ]; then
    echo "  スキップ: $FILE_NAME (ファイルなし)"
    return
  fi

  echo "  ▶ $FILE_NAME をプッシュ中..."

  # Base64エンコード（macOS/Linux両対応）
  if [[ "$(uname)" == "Darwin" ]]; then
    local CONTENT_B64=$(base64 -i "$FILE_PATH" | tr -d '\n')
  else
    local CONTENT_B64=$(base64 -w 0 "$FILE_PATH")
  fi

  # 既存ファイルのSHAを取得（更新時に必要）
  local EXISTING_SHA=$(curl -s "https://api.github.com/repos/$USERNAME/$REPO_NAME/contents/$FILE_NAME" \
    -H "Authorization: token $TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null || echo "")

  local PAYLOAD
  if [ -n "$EXISTING_SHA" ] && [ "$EXISTING_SHA" != "" ]; then
    echo "    更新中... (SHA: ${EXISTING_SHA:0:8}...)"
    PAYLOAD="{\"message\":\"Update $FILE_NAME - 小学校区レイヤー追加\",\"content\":\"$CONTENT_B64\",\"sha\":\"$EXISTING_SHA\"}"
  else
    echo "    新規プッシュ中..."
    PAYLOAD="{\"message\":\"Add $FILE_NAME\",\"content\":\"$CONTENT_B64\"}"
  fi

  curl -s -X PUT "https://api.github.com/repos/$USERNAME/$REPO_NAME/contents/$FILE_NAME" \
    -H "Authorization: token $TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    -d "$PAYLOAD" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'    ✅ {d.get(\"content\",{}).get(\"html_url\", d.get(\"message\", \"error\"))}')"
}

for f in "${DEPLOY_FILES[@]}"; do
  push_file "$SCRIPT_DIR/$f"
done

echo ""
echo "=== Step 3: GitHub Pages有効化確認 ==="
PAGES_CHECK=$(curl -s -o /dev/null -w "%{http_code}" \
  "https://api.github.com/repos/$USERNAME/$REPO_NAME/pages" \
  -H "Authorization: token $TOKEN")

if [ "$PAGES_CHECK" = "200" ]; then
  echo "GitHub Pagesは既に有効です。"
else
  curl -s -X POST "https://api.github.com/repos/$USERNAME/$REPO_NAME/pages" \
    -H "Authorization: token $TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    -d "{\"source\":{\"branch\":\"main\",\"path\":\"/\"}}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Pages URL: {d.get(\"html_url\", d.get(\"message\", \"error\"))}')"
fi

echo ""
echo "=== 完了 ==="
echo "数分後に以下のURLでアクセスできます："
echo "  https://$USERNAME.github.io/$REPO_NAME/"
echo ""
echo "※ GitHub Pagesの更新には1-2分かかる場合があります"
