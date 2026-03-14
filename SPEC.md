# 三重県北部 不動産おすすめエリア診断「夢のすみか」— 仕様書

**最終更新**: 2026-02-13 (commit: 075ffa8)
**ファイル**: `index.html` (単一ファイル構成、約2,654行)
**デプロイ先**: GitHub Pages (`ryota-hagi/mie-realestate-app`)
**リポジトリ**: https://github.com/ryota-hagi/mie-realestate-app

---

## 1. アプリ概要

三重県北部7エリアの不動産情報を、ユーザーの重み付けに基づいてスコアリング・ランキングし、地図上に取引データをプロットするWebアプリ。MCP経由でREINFOLIB APIからリアルタイム取引データを取得する。ページアクセス時に自動でMCP接続＆全エリアデータ取得を開始する。

## 2. 対象エリア（AREAS配列）

| id | name | cityCode | 座標 |
|----|------|----------|------|
| yokkaichi | 四日市市 | 24202 | 34.9650, 136.6244 |
| kuwana | 桑名市 | 24205 | 35.0585, 136.6834 |
| suzuka | 鈴鹿市 | 24207 | 34.8824, 136.5842 |
| inabe | いなべ市 | 24212 | 35.1146, 136.5612 |
| kameyama | 亀山市 | 24210 | 34.8540, 136.4520 |
| komono | 菰野町 | 24341 | 35.0244, 136.5090 |
| toin | 東員町 | 24343 | 35.0690, 136.6030 |

各エリアには以下のデータを持つ:
- 地価情報: landPriceAvg, residentialPrice, commercialPrice, pricePerTsubo
- 人口: population, popGrowthRate
- アクセス: accessToNagoya（名古屋までの分数）
- 生活: hospitals, schools, parks, shopping, safetyScore, childcareScore, naturalScore
- テキスト: description, highlights[], risks[], recAreas[]
- 地価推移: trend[{y, p}]

## 3. 画面構成（state.view）

### 3.1 ranking — ランキング画面
- 重み付けスライダー6項目でスコア調整
- カード一覧（メダル表示: 🥇🥈🥉）

### 3.2 compare — 比較画面
- 全エリアの棒グラフ比較（Chart.js）

### 3.3 detail — 詳細画面
- 個別エリアの詳細情報、レーダーチャート、地価推移

### 3.4 map — 地図画面 ★メイン機能
- Leaflet.js地図 + 右サイドバー（340px幅）
- エリアマーカー（順位・スコア表示のSVGアイコン）
- 取引ピン（circleMarker、価格で色分け）
- トグルレイヤー: 🏫学区 / 📊エリア
- **全画面表示**: ⛶拡大ボタンで地図を全画面化、フローティングコントロールバー表示

## 4. スコア計算（calcScores）

```
priceScore  = 100 - ((residentialPrice - 20000) / 40000) * 100
accessScore = ((70 - accessToNagoya) / 70) * 100
growthScore = min(100, max(0, (yoyChange / 2) * 100))
livingScore = (hospitals/45)*25 + (schools/60)*25 + (shopping/120)*25 + (safetyScore/100)*25
familyScore = (childcareScore + safetyScore + min(100,(parks/35)*100)) / 3
natureScore = naturalScore

total = 各スコア × 重み(%)の合計
```

デフォルト重み: price:25, access:20, growth:15, living:15, family:15, nature:10

## 5. MCP接続・データ取得

### 5.1 接続（connectMCP）
- MCPClientクラス: `CONFIG.MCP_REINFO` + `CONFIG.PROXY_URL`経由
- プロキシURL: Supabase Edge Function → `mcp.n-3.ai/v1/sse`
- ツール: `reinfolib-real-estate-price`, `reinfolib-city-list`
- **ページロード時に自動接続** → Phase1 → Phase2自動開始

### 5.2 Phase 1 — 概要取得（fetchLiveData）
- 全7エリア × 1リクエスト（year: '2024'、quarterなし）
- **APIは1リクエストあたり10件**を返す
- `updateAreasWithLiveData()` で `area._liveTransactions` に格納

### 5.3 Phase 2 — 詳細取得（fetchAreaFullData）
- **自動取得**: `fetchAllAreasData()`がPhase1完了後にバックグラウンドで全エリアを順次取得
- **優先取得**: ユーザーがマーカークリックしたエリアは`_fetchPriorityAreaId`で優先
- 5年 × 4四半期 = **20リクエスト**を順次実行
- 各リクエスト10件 → **最大200件/エリア**
- **ローディングオーバーレイ**: 選択中エリアのみ表示（`showOverlay`オプション）、バックグラウンド取得時は非表示
- 完了後:
  1. `updateAreasWithLiveData()` でデータマージ
  2. `updateMapSidebar(rankedArea, ranked)` ← **rankedから取得（scoresが必要）**
  3. `await geocodeAreaDistricts(area, { showOverlay })` で地区位置解決
  4. `showTransactionPins(area)` でピン再描画
  5. `geocodeDistrictsBackground()` をバックグラウンド実行
- `AREA_FULL_LOADED` Setで二重取得を防止

### 5.4 fetchAllAreasData（全エリア自動取得オーケストレータ）
- `_autoFetchRunning`フラグで二重実行防止
- whileループで全エリア順次処理:
  1. `_fetchPriorityAreaId`（ユーザー選択）を最優先
  2. なければ`AREAS`順に未取得エリアを選択
- ステータステキスト: `${areaName} 詳細取得中... （残り${remaining}エリア）`
- 全完了後: 合計件数表示 + 全ピン表示（`showAllTransactionPins`）

### 5.5 extractTransactionsFromMCPResponse
MCP応答からトランザクション配列を抽出:
- 標準形式: `{ content: [{ type: 'text', text: '{"data": [...]}' }] }`
- 代替形式にも対応（直接data配列、文字列パース、他キー名検索）
- 各段階でconsole.log出力あり

### 5.6 updateAreasWithLiveData
1. sources（quarters配列）からextractで全レコード取得
2. 重複排除: TradePrice + District + Area + **Period + Type + BuildingYear + NearestStation + FloorPlan + Structure** の9項目キー
3. `area._liveTransactions` に格納（元データ完全置換）
4. 格納フィールド: TradePrice(parseInt), Type, Area(parseFloat), FloorPlan, BuildingYear, NearestStation, DistanceToStation, Use, District, Structure, CityPlanning, **Period**

## 6. 取引ピン表示

### 6.1 showAllTransactionPins(ranked)
- **AREAS本体を直接ループ**（rankedコピーではなく最新データ参照）
- 全エリアのgeocodeAreaDistrictsを先に実行
- **TradePrice無しもグレーピン（opacity 0.4）で表示**
- radius: 5, weight: 1

### 6.2 showTransactionPins(area)
- **`AREAS.find(a => a.id === area.id)`で常に本体から最新の`_liveTransactions`を取得**
- rankedコピーの古いデータを参照しない
- `txMarkersByIdx[i]` にマーカー+位置を保存（サイドバー連携用）
- **TradePrice無しもグレーピン（opacity 0.4）で表示**
- radius: 7, weight: 1.5

### 6.3 ピン色（priceColor）
| 価格帯 | 色 |
|--------|-----|
| 価格なし/NaN | #9ca3af（グレー） |
| < 500万 | #22c55e（緑） |
| 500-1500万 | #3b82f6（青） |
| 1500-3000万 | #f59e0b（琥珀） |
| 3000-5000万 | #ef4444（赤） |
| > 5000万 | #7c3aed（紫） |

### 6.4 ピンクリック → ポップアップ（buildTxPopup）
- 価格、地区、面積、種別、最寄駅（距離）、築年、構造

## 7. 取引位置推定（estimateTxPosition）

**4段階の優先度**で位置を決定:

1. **Priority 1: DISTRICT_CACHE** — `findDistrictCoords(district, cityName)` でジオコード済み座標 + jitter
2. **Priority 2: 駅座標** — `findStationCoords(nearestStation)` + distance-based offset
3. **Priority 3: 地区名→駅名ファジーマッチ** — STATION_COORDS内の部分一致 + jitter
4. **Priority 4: ハッシュベースフォールバック** — `hashStr(districtKey + area.id)` で市中心から放射状配置

jitter: `idx * 137.508°`（黄金角）で螺旋状に分散

## 8. 地区ジオコーディング

### 8.1 DISTRICT_CACHE
- localStorage `mie_realestate_district_cache_v2` に保存
- Map形式: `${cityName}-${district}` → `{lat, lng}`

### 8.2 geocodeDistrict(district, cityName)
- **Primary: GSI API** (`msearch.gsi.go.jp/address-search/AddressSearch`)
  - クエリ1: `三重県${cityName}${district}`
  - クエリ2: `${cityName}${district}`
- **Fallback: Nominatim** (`nominatim.openstreetmap.org/search`)
- レート制限: 300ms間隔

### 8.3 geocodeAreaDistricts(area, options)
- 特定エリアの未キャッシュ地区をジオコード
- **ピン表示前にawaitで実行**（同期的にブロック）
- `showOverlay`オプション: 選択中エリアのみオーバーレイ表示

### 8.4 geocodeDistrictsBackground()
- 全エリアの未キャッシュ地区をバックグラウンドでジオコード
- 完了後にピン位置を更新（showTransactionPins再呼出し）

## 9. トグルレイヤー

### 9.1 🏫 学区（toggleSchoolDistricts）
- `school-districts.geojson` を読み込み
- GeoJSONポリゴン表示（半透明カラー）
- 学校位置に📍マーカー + ツールチップ

### 9.2 📊 エリア（toggleDistrictAreas）
- DISTRICT_CACHEから地区座標を取得
- 各地区にL.circle表示（取引数に応じたサイズ: 200-600m）
- クリックで `updateDistrictSidebar()` 表示

## 10. 全画面表示機能

### 10.1 CSS
- `.map-fullscreen`: `position: fixed; top:0; left:0; width:100vw; height:100vh; z-index:9999`
- `#map-container`, `#map-sidebar`: 全画面時に `height: 100vh; border-radius: 0`
- `.map-fullscreen-controls`: `position: fixed; top:12px; left:50%; transform:translateX(-50%); z-index:10001`
  - 背景: `rgba(255,255,255,0.92)` + `backdrop-filter: blur(8px)`（すりガラス効果）
  - 通常時非表示(`display:none`)、`.visible`で表示(`display:flex`)

### 10.2 toggleMapFullscreen()
- `_mapFullscreen`フラグ切替
- 全画面ON: `.map-fullscreen`クラス追加、フローティングコントロール表示、body scrollロック
- 全画面OFF: クラス除去、コントロール非表示、scroll復帰
- `mapInstance.invalidateSize()` で地図サイズ再計算（200ms遅延）
- ESCキーで全画面解除対応

### 10.3 フローティングコントロール
- 画面上部中央に配置（Leafletズームボタン左上と重ならない）
- 含むボタン: 🗺️エリアマップ ラベル + 📊エリア + 🏫学区 + ✕閉じる

## 11. サイドバー

### 11.1 updateMapSidebar(area, ranked)
- **2つの参照を使い分け**:
  - `rankedArea = ranked.find(...)` → scores表示用（rankedコピーにscoresあり）
  - `canonical = AREAS.find(...)` → 取引データ用（AREAS本体に最新_liveTransactionsあり）
- ヘッダー: メダル + エリア名 + スコア（`rankedArea.scores.total`）
- ステータスバッジ:
  - 取得中: 🔵 詳細データ取得中...
  - 完了: ✅ 全期間データ取得済み（N件）
  - 概要のみ: 概要データのみ（N件）
- メトリクス: 住宅地価格、名古屋アクセス、人口、前年比変動
- 取引リスト（`renderTransactionList(canonical._liveTransactions)`）

### 11.2 updateDistrictSidebar(area, districtName, ranked)
- 「← 市名に戻る」ボタン + 地区名
- 2×3メトリクスグリッド: 平均価格、m²単価、最寄駅、名古屋通勤、駅距離、築年数
- 種別分布バー
- フィルター済み取引テーブル（_areaIdxで正しいピン連携）
- goBackボタン → `updateMapSidebar(area, ranked)` + `showTransactionPins(area)`

### 11.3 renderTransactionList(transactions)
- **全取引表示**（TradePrice無しも「-」として表示）
- ソート: 価格降順（null値は末尾）
- クリックで `flyToTransaction(idx)` → 地図上のピンへ移動・ポップアップ表示
- `_areaIdx` があれば元インデックスとして使用（地区フィルタ時）

## 12. STATION_TO_NAGOYA_MIN

約50駅の名古屋までの所要時間（分）テーブル:
```
近鉄四日市:35, 四日市:50, 富田:38, 桑名:25, 白子:55, 亀山:70,
近鉄富田:38, 伊勢朝日:30, 益生:27, 長島:22, 菰野:55, ...
```

## 13. 重要な注意点・過去のバグ修正

### 13.1 getRankedAreas()のshallow copy問題 ★★★最重要
- `AREAS.map(a => ({ ...a, scores: calcScores(...) }))` — **新オブジェクト生成（shallow copy）**
- コピー時点の`_liveTransactions`を保持 → Phase2で`AREAS`本体が更新されてもコピーは**古いまま**
- **解決策**: ピン表示・サイドバーでは常に`AREAS.find()`で本体参照
  - `showTransactionPins`: `const canonical = AREAS.find(a => a.id === area.id)`
  - `showAllTransactionPins`: `AREAS.forEach(area => ...)` で直接ループ
  - `updateMapSidebar`: `canonical = AREAS.find(...)` で取引データ取得、`rankedArea = ranked.find(...)` でscores取得

### 13.2 fetchAreaFullData内のupdateMapSidebarエラー
- **原因**: `AREAS.find()` で取得した元オブジェクトには `scores` がない
- **修正**: `ranked.find(a => a.id === areaId)` で scores付きオブジェクトを使用
- **影響**: このエラーでPhase2の200件ピンが表示されなかった

### 13.3 updateMapSidebar内のscoresエラー（goBack経由）
- **原因**: `updateDistrictSidebar`の`goBack`ハンドラが`area`（AREAS直参照）を渡す
- **修正**: `updateMapSidebar`冒頭で`ranked.find()`を使いscores付きオブジェクトに変換

### 13.4 TradePrice解析
- `d.TradePrice != null && d.TradePrice !== ''` で判定（0もnull化しない）
- `parseInt()` で数値変換、`isNaN()` チェック
- API応答はstring型の数値（例: "15000000"）

### 13.5 ジオコーディング順序
- `geocodeAreaDistricts(area)` は **showTransactionPins前にawait**で実行
- これを守らないとDISTRICT_CACHE空 → 全ピンがフォールバック位置に集中

### 13.6 API制限
- `reinfolib-real-estate-price` は**1リクエスト10件**固定
- Phase1: 7エリア × 10件 = 70件
- Phase2: 20Q × 10件 = 200件/エリア

### 13.7 ローディングオーバーレイ
- `fetchAreaFullData(areaId, { showOverlay })` で制御
- 選択中エリアのみオーバーレイ表示、バックグラウンド取得は非表示
- ステータステキストのみ更新（`updateStatusText()`）

## 14. ページロード時の自動実行フロー

```
loadDistrictCache()        // localStorageから地区キャッシュ読み込み
render()                   // 初期描画
connectMCP()               // 自動MCP接続
  ├─ Phase 1: fetchLiveData()     // 全7エリア概要（各10件）
  └─ Phase 2: fetchAllAreasData() // 全エリア詳細を順次取得（awaitしない）
       ├─ _fetchPriorityAreaId優先
       ├─ 各エリア fetchAreaFullData(id)
       └─ 完了後 showAllTransactionPins()
```

## 15. グローバル変数（データ取得関連）

| 変数名 | 型 | 用途 |
|--------|-----|------|
| `AREA_FULL_LOADED` | Set | Phase2完了済みエリアID |
| `_currentFetchAreaId` | string/null | 現在取得中のエリアID |
| `_fetchPriorityAreaId` | string/null | ユーザー選択による優先取得エリア |
| `_autoFetchRunning` | boolean | fetchAllAreasData実行中フラグ |
| `_mapFullscreen` | boolean | 全画面表示状態 |
| `mapInstance` | L.Map | Leaflet地図インスタンス |
| `txMarkerLayer` | L.LayerGroup | 取引ピンレイヤー |
| `txMarkersByIdx` | Object | ピンインデックス→マーカー対応表 |
| `mapMarkers` | Object | エリアID→マーカー対応表 |
| `showSchoolDistricts` | boolean | 学区レイヤー表示状態 |
| `showDistrictAreas` | boolean | エリアレイヤー表示状態 |

## 16. ファイル構成

```
mie-deploy/
├── index.html           # メインアプリ（全コード含む、約2,654行）
└── school-districts.geojson  # 学区データ（約680KB）
```

## 17. デプロイ手順

```bash
cd /sessions/nice-peaceful-euler/mie-deploy
git add index.html
git commit -m "説明"
git push origin main
# GitHub Pagesで自動反映（1-2分）
```

ワークスペースにも同期:
```bash
cp index.html "/sessions/nice-peaceful-euler/mnt/作業用/mie-realestate-app/index.html"
```

## 18. GitHub情報

- リポジトリ: `ryota-hagi/mie-realestate-app`
- ユーザー名: `ryota-hagi`
- ブランチ: `main`

## 19. コミット履歴（本セッション）

| コミット | 内容 |
|----------|------|
| `6501c6a` | Dedup key改善 + TradePrice解析 |
| `ce94c99` | デバッグログ + TradePrice-nullピン + 堅牢な抽出 |
| `16385ac` | updateMapSidebar TypeError修正（rankedArea使用） |
| `ac4a14d` | 自動MCP接続 + fetchAllAreasData |
| `4ee5eba` | バックグラウンドオーバーレイ制御 |
| `9e9b89c` | 地図の全画面表示ボタン追加 |
| `3fa503f` | updateMapSidebar goBack時のscoresエラー修正 |
| `4cffa6f` | 全画面コントロールバーを中央配置 |
| `075ffa8` | ★ ピン表示でAREAS本体の最新_liveTransactions参照に修正 |
