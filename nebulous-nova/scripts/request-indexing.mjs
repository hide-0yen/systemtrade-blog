import { GoogleAuth } from 'google-auth-library';
import { execSync } from 'child_process';

const SITE_URL = process.env.SITE_URL ?? 'https://systemtrade.blog';
const BLOG_CONTENT_DIR = 'nebulous-nova/src/data/blog/';
const INDEXING_API_ENDPOINT =
  'https://indexing.googleapis.com/v3/urlNotifications:publish';
const DRY_RUN = process.env.DRY_RUN === 'true';

function getChangedBlogUrls() {
  let diffOutput;
  try {
    diffOutput = execSync('git diff --name-only HEAD~1 HEAD', {
      encoding: 'utf-8',
    });
  } catch {
    console.log('git diff に失敗しました。スキップします。');
    return [];
  }

  return diffOutput
    .split('\n')
    .map(f => f.trim())
    .filter(f => f.startsWith(BLOG_CONTENT_DIR) && f.endsWith('.md'))
    .map(f => {
      const slug = f.replace(BLOG_CONTENT_DIR, '').replace(/\.md$/, '');
      return `${SITE_URL}/posts/${slug}/`;
    });
}

async function submitUrl(client, url) {
  const response = await client.request({
    url: INDEXING_API_ENDPOINT,
    method: 'POST',
    data: { url, type: 'URL_UPDATED' },
  });
  return response.data;
}

async function main() {
  const serviceAccountJson = process.env.GSC_INDEXING_SERVICE_ACCOUNT;
  if (!serviceAccountJson) {
    console.log('GSC_INDEXING_SERVICE_ACCOUNT が未設定のためスキップします。');
    process.exit(0);
  }

  const urls = getChangedBlogUrls();
  if (urls.length === 0) {
    console.log('変更されたブログ記事はありません。');
    process.exit(0);
  }

  console.log(`インデックス申請対象: ${urls.length} 件`);
  urls.forEach(url => console.log(`  ${url}`));

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 申請はスキップされました。');
    process.exit(0);
  }

  const auth = new GoogleAuth({
    credentials: JSON.parse(serviceAccountJson),
    scopes: ['https://www.googleapis.com/auth/indexing'],
  });
  const client = await auth.getClient();

  let successCount = 0;
  let failCount = 0;

  for (const url of urls) {
    try {
      const result = await submitUrl(client, url);
      const notifyTime =
        result.urlNotificationMetadata?.latestUpdate?.notifyTime ?? '-';
      console.log(`OK ${url} (notifyTime: ${notifyTime})`);
      successCount++;
    } catch (err) {
      const status = err.response?.status ?? 'unknown';
      const message = err.response?.data?.error?.message ?? err.message;
      console.error(`NG ${url} [HTTP ${status}]: ${message}`);
      failCount++;
    }
  }

  console.log(`\n完了: 成功 ${successCount} 件 / 失敗 ${failCount} 件`);

  if (successCount === 0 && failCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
