# Supabase メールテンプレート設定手順

## 設定場所
Supabase Dashboard → Authentication → Email Templates
https://supabase.com/dashboard/project/jvfmvitknqnmuduyscnl/auth/templates

## 設定するテンプレート（3つ）

### 1. Magic Link (マジックリンク)
- **Subject**: `【注文相談.com】ログイン認証コード`
- **Body**: `magic-link.html` の内容をコピペ

### 2. Confirm signup (サインアップ確認)
- **Subject**: `【注文相談.com】メールアドレスの確認`
- **Body**: `confirm-signup.html` の内容をコピペ

### 3. Change Email Address (メールアドレス変更)
- **Subject**: `【注文相談.com】メールアドレスの確認`
- **Body**: `change-email.html` の内容をコピペ

## 手順
1. 上記URLをブラウザで開く
2. 各テンプレートタブを選択
3. Subjectを入力
4. Bodyに対応するHTMLファイルの内容を貼り付け
5. 「Save」をクリック
