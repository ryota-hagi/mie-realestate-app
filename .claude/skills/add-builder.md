---
name: add-builder
description: 三重県の工務店・ハウスメーカー・設計事務所を追加。「〇〇を追加して」で工務店カード+イベントスクレイピング+ビルド+プッシュまで自動実行。
triggers:
  - "追加して"
  - "工務店を追加"
  - "ビルダーを追加"
  - "add builder"
---

# 工務店追加スキル

ユーザーが「〇〇を追加して」と言ったら、以下のフローを自動実行する。

## 入力
- 工務店名（日本語）
- オプション: 公式サイトURL（指定がなければWebSearchで調査）

## 実行フロー

### Phase 1: 情報収集（WebSearch + WebFetch）

1. **公式サイトを特定**
   - WebSearchで「{会社名} 三重県 注文住宅 公式サイト」を検索
   - 公式サイトURLを特定

2. **基本情報を収集**
   - 公式サイトから以下を抽出:
     - 正式名称
     - 坪単価の目安（min/max）
     - 構造・工法
     - 対応エリア（三重県内のどの市町）
     - 特徴・強み
     - ショールーム/展示場の所在地
     - イベントページURL
   - 「{会社名} 坪単価」「{会社名} 口コミ」「{会社名} 特徴」でWebSearch補完

3. **SNS情報を収集**
   - 公式サイトのヘッダー/フッターからSNSリンクを探す
   - 見つからない場合はWebSearchで「{会社名} instagram」等で調査
   - Instagram, X(Twitter), YouTube, Facebook, LINEを対象

### Phase 2: データ作成

4. **builders-data.jsonにエントリ追加**

   以下のフィールドを埋める：
   ```json
   {
     "id": "{kebab-case}",
     "name": "{正式名称}",
     "grade": "standard|lowcost|highgrade",
     "type": "local|franchise|national",
     "tsuboPrice": { "min": XX, "max": XX },
     "tagline": "{一行キャッチコピー}",
     "structure": "{工法}",
     "areas": ["{対応エリアコード}"],
     "features": ["{特徴1}", "{特徴2}", "{特徴3}", "{特徴4}"],
     "pros": ["{強み1}", "{強み2}", "{強み3}"],
     "cons": ["{弱み1}", "{弱み2}"],
     "warranty": { "structure": XX, "leak": XX },
     "recommended_for": ["{推奨ユーザー1}", "{推奨ユーザー2}", "{推奨ユーザー3}"],
     "summary": "{200文字程度の概要}",
     "officialUrl": "{公式URL}",
     "showrooms": ["{展示場所在地}"],
     "mie_presence": "{三重県での展開状況}",
     "sns": {
       "instagram": "{URL or null}",
       "x": "{URL or null}",
       "youtube": "{URL or null}",
       "facebook": "{URL or null}",
       "line": "{URL or null}"
     },
     "eventsPageUrl": "{イベントページURL}"
   }
   ```

   **gradeの判定基準:**
   - lowcost: 坪単価max < 55万円
   - standard: 55万円 ≤ max < 80万円
   - highgrade: max ≥ 80万円

   **typeの判定基準:**
   - local: 三重県（+隣県）のみで展開
   - franchise: 全国FC加盟店
   - national: 全国展開の大手HM

   **areasのコード:**
   yokkaichi, kuwana, suzuka, inabe, kameyama, komono, toin

   **追加方法:** Node.jsスクリプトを書いてbuilders-data.jsonのbuilders配列にpushし、JSON.stringify(data, null, 2)で保存。

### Phase 3: イベントスクレイピング設定

5. **イベントページの構造を調査**
   - Puppeteerでイベントページにアクセス
   - イベントカード/リストの構造を分析
   - CSSセレクタを特定

6. **scrape-events.mjsにスクレイパー追加**
   - `async function scrape{PascalCase}(page)` を追加
   - `SCRAPERS` オブジェクトに `'{id}': scrape{PascalCase}` を登録
   - `LOCAL_BUILDER_IDS` 配列に `'{id}'` を追加
   - 既存のスクレイパー関数を参考にパターンを踏襲

   **スクレイパー関数のテンプレート:**
   ```javascript
   async function scrapeNewBuilder(page) {
     await page.goto('{eventsPageUrl}', { waitUntil: 'networkidle2', timeout: 25000 });
     await wait(2000);
     return page.evaluate(() => {
       const results = [];
       document.querySelectorAll('{eventCardSelector}').forEach(card => {
         const titleEl = card.querySelector('{titleSelector}');
         const linkEl = card.querySelector('a[href]');
         if (!titleEl) return;
         results.push({
           title: titleEl.textContent.trim(),
           meta: card.textContent.replace(/\s+/g, ' ').trim().substring(0, 200),
           sourceUrl: linkEl ? linkEl.href : ''
         });
       });
       return results;
     });
   }
   ```

7. **スクレイピング実行**
   ```bash
   node scripts/scrape-events.mjs
   ```

### Phase 4: ビルド・検証・デプロイ

8. **ビルド実行**
   ```bash
   node scripts/build-pages.mjs
   ```

9. **検証**
   - `/builders/{id}/index.html` が生成されていること
   - ビルダー一覧ページに新カードが表示されること
   - イベントカレンダーにイベントが反映されること

10. **コミット・プッシュ**
    ```bash
    git add scripts/builders-data.json scripts/events-data.json scripts/scrape-events.mjs builders/
    git commit -m "feat: {会社名}を工務店一覧に追加（イベント情報含む）"
    git push origin main
    ```

## 完了報告

最後にユーザーに以下を報告：
- 追加した工務店名
- 生成されたページURL: `/builders/{id}/`
- 取得できたイベント件数
- カレンダーへの反映状況

## 注意事項

- 大手HM（ダイワハウス・セキスイハイム・パナソニック等）は追加しない（CLAUDE.mdのSEO方針）
- 公式サイトが見つからない場合はユーザーに確認
- 坪単価が不明な場合は近い規模の工務店を参考に推定し、推定値であることを明記
- SNSが1つも見つからない場合は `sns: {}` とする
- イベントページが存在しない/スクレイプ不可の場合はスクレイパー追加をスキップ
