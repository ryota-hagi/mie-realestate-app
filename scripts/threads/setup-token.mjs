#!/usr/bin/env node
/**
 * Threads OAuth セットアップ補助ツール
 * ローカルで実行して、Threads API のアクセストークンを取得する
 *
 * 使い方:
 *   THREADS_APP_ID=xxx THREADS_APP_SECRET=xxx node scripts/threads/setup-token.mjs
 *
 * 手順:
 *   1. ブラウザで認証URLが表示される → ブラウザで開いて認証
 *   2. リダイレクトされたURLをコピーして貼り付け
 *   3. 短期トークン → 長期トークンに自動交換
 *   4. 表示されたトークンとユーザーIDをGitHub Secretsに登録
 */

import { createServer } from 'https';
import { readFileSync } from 'fs';
import { URL, fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const APP_ID = process.env.THREADS_APP_ID;
const APP_SECRET = process.env.THREADS_APP_SECRET;
const REDIRECT_URI = 'https://localhost:8899/callback';

// SSL証明書読み込み
const sslOptions = {
  key: readFileSync(join(__dirname, 'localhost-key.pem')),
  cert: readFileSync(join(__dirname, 'localhost-cert.pem')),
};
const SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_read_replies',
  'threads_manage_replies',
  'threads_manage_insights',
  'threads_keyword_search',
].join(',');

if (!APP_ID || !APP_SECRET) {
  console.error('❌ 環境変数を設定してください:');
  console.error('   THREADS_APP_ID=あなたのApp ID');
  console.error('   THREADS_APP_SECRET=あなたのApp Secret');
  console.error('');
  console.error('取得方法:');
  console.error('   1. https://developers.facebook.com/ にログイン');
  console.error('   2. アプリを作成（Use Case: Other, Type: Business）');
  console.error('   3. Threads API を追加');
  console.error('   4. アプリダッシュボードでApp IDとApp Secretを確認');
  process.exit(1);
}

// ============================================================
// Step 1: 認証URL生成
// ============================================================

const authUrl = `https://threads.net/oauth/authorize?` +
  `client_id=${APP_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${SCOPES}` +
  `&response_type=code`;

console.log('');
console.log('🧵 Threads OAuth セットアップ');
console.log('=========================================');
console.log('');
console.log('以下のURLをブラウザで開いて認証してください:');
console.log('');
console.log(authUrl);
console.log('');
console.log('認証後、ローカルサーバーにリダイレクトされます...');
console.log('');

// ============================================================
// Step 2: コールバックサーバー起動
// ============================================================

const server = createServer(sslOptions, async (req, res) => {
  const url = new URL(req.url, `https://localhost:8899`);

  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>❌ 認証エラー</h1><p>${error}</p>`);
    console.error(`❌ 認証エラー: ${error}`);
    server.close();
    process.exit(1);
    return;
  }

  if (!code) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>❌ コードが取得できませんでした</h1>');
    server.close();
    process.exit(1);
    return;
  }

  console.log('✅ 認証コード取得成功');
  console.log('🔄 短期トークンを取得中...');

  try {
    // Step 3: 認証コード → 短期トークン
    const tokenRes = await fetch('https://graph.threads.net/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: APP_ID,
        client_secret: APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code,
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      throw new Error(`トークン取得失敗: ${JSON.stringify(tokenData)}`);
    }

    const shortLivedToken = tokenData.access_token;
    const userId = tokenData.user_id;
    console.log(`✅ 短期トークン取得成功 (ユーザーID: ${userId})`);

    // Step 4: 短期トークン → 長期トークン
    console.log('🔄 長期トークンに交換中...');
    const longRes = await fetch(
      `https://graph.threads.net/access_token?` +
      `grant_type=th_exchange_token` +
      `&client_secret=${APP_SECRET}` +
      `&access_token=${shortLivedToken}`
    );

    const longData = await longRes.json();

    if (longData.error) {
      throw new Error(`長期トークン交換失敗: ${JSON.stringify(longData)}`);
    }

    const longLivedToken = longData.access_token;
    const expiresIn = longData.expires_in; // 秒

    console.log('');
    console.log('=========================================');
    console.log('✅ セットアップ完了！');
    console.log('=========================================');
    console.log('');
    console.log('以下の値をGitHub Secretsに登録してください:');
    console.log('');
    console.log(`THREADS_USER_ID = ${userId}`);
    console.log(`THREADS_ACCESS_TOKEN = ${longLivedToken}`);
    console.log('');
    console.log(`トークン有効期限: ${Math.floor(expiresIn / 86400)}日`);
    console.log(`有効期限日: ${new Date(Date.now() + expiresIn * 1000).toLocaleDateString('ja-JP')}`);
    console.log('');
    console.log('GitHub Secretsの登録手順:');
    console.log('  1. リポジトリ → Settings → Secrets and variables → Actions');
    console.log('  2. "New repository secret" をクリック');
    console.log('  3. 上記の3つの値をそれぞれ登録');
    console.log('     (ANTHROPIC_API_KEY も忘れずに)');
    console.log('');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <h1>✅ セットアップ完了！</h1>
      <p>ターミナルに表示された値をGitHub Secretsに登録してください。</p>
      <p>このページは閉じてOKです。</p>
    `);
  } catch (e) {
    console.error(`❌ エラー: ${e.message}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>❌ エラー</h1><p>${e.message}</p>`);
  }

  server.close();
});

server.listen(8899, () => {
  console.log('🌐 コールバックサーバー起動: https://localhost:8899');
});
