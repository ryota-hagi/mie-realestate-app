#!/usr/bin/env node
/**
 * Threads 返信対応スクリプト
 * 自分の投稿への返信を読み取り、AIで自然なコメントを返す
 *
 * GitHub Actions で毎日 12:00 JST に実行
 */

import { getMyThreads, getReplies, publishReply, checkAndRefreshToken } from './lib/threads-api.mjs';
import { generateReply } from './lib/ai-generator.mjs';
import { loadHistory, saveHistory, hasRepliedTo } from './lib/history.mjs';

const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_REPLIES_PER_RUN = parseInt(process.env.MAX_REPLIES || '10', 10);

async function main() {
  console.log('🧵 Threads返信対応 開始');
  console.log(`📅 ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('🏃 DRY RUN モード');

  // トークンチェック
  if (!DRY_RUN) {
    const tokenStatus = await checkAndRefreshToken();
    if (!tokenStatus.valid) {
      console.error('❌ Threadsトークンが無効です。');
      process.exit(1);
    }
  }

  // 自分の最近の投稿を取得
  console.log('📥 最近の投稿を取得中...');
  const myThreads = await getMyThreads(10);
  console.log(`   ${myThreads.length}件の投稿を取得`);

  let repliesProcessed = 0;

  for (const thread of myThreads) {
    if (repliesProcessed >= MAX_REPLIES_PER_RUN) {
      console.log(`🛑 返信上限 (${MAX_REPLIES_PER_RUN}件) に到達`);
      break;
    }

    // 各投稿への返信を取得
    let replies;
    try {
      replies = await getReplies(thread.id);
    } catch (e) {
      console.warn(`   ⚠️ 返信取得失敗 (${thread.id}): ${e.message}`);
      continue;
    }

    if (replies.length === 0) continue;

    console.log(`📝 投稿 ${thread.id} への返信: ${replies.length}件`);

    for (const reply of replies) {
      if (repliesProcessed >= MAX_REPLIES_PER_RUN) break;

      // 自分自身の返信はスキップ
      const myUserId = process.env.THREADS_USER_ID;
      if (reply.username === myUserId) continue;

      // 既に返信済みならスキップ
      if (hasRepliedTo(reply.id)) {
        console.log(`   ⏭️ 既に返信済み: ${reply.id}`);
        continue;
      }

      // 返信テキストが空や短すぎる場合スキップ
      if (!reply.text || reply.text.length < 5) continue;

      console.log(`   💬 "${reply.text.slice(0, 50)}..." に返信を生成中...`);

      try {
        // AIで返信生成
        const context = thread.text ? `元の投稿: ${thread.text.slice(0, 100)}` : '';
        const replyText = await generateReply(reply.text, context);

        console.log(`   ✅ 生成 (${replyText.length}文字): "${replyText.slice(0, 50)}..."`);

        // 投稿
        let replyId = 'dry-run';
        if (!DRY_RUN) {
          const result = await publishReply(reply.id, replyText);
          replyId = result.id;
          console.log(`   🧵 返信投稿完了: ${replyId}`);

          // API呼出間にちょっと待つ
          await new Promise(r => setTimeout(r, 2000));
        }

        // 履歴保存
        saveHistory({
          date: new Date().toISOString(),
          category: 'reply',
          topicKey: `reply:${reply.id}`,
          text: replyText,
          threadId: replyId,
          repliedTo: reply.id,
          charCount: replyText.length,
        });

        repliesProcessed++;
      } catch (e) {
        console.warn(`   ⚠️ 返信失敗: ${e.message}`);
      }
    }
  }

  console.log(`✅ 完了: ${repliesProcessed}件の返信を処理`);
}

main().catch(e => {
  console.error('💥 致命的エラー:', e);
  process.exit(1);
});
