// テスト環境（functions/test/[[path]].js）: /test/ 以下を、同じファイルに分離の見出しを付けて返すか
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest, ISOLATION_HEADERS } from '../functions/test/[[path]].js';

const env = {
  ASSETS: {
    fetch: async req => {
      const p = new URL(req.url).pathname;
      if (p === '/index.html') return new Response(null, { status: 308, headers: { Location: '/' } });
      return new Response(`asset:${p}`, { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public' } });
    },
  },
};
const call = path => onRequest({ request: new Request('https://example.pages.dev' + path), env });

test('/test/ はトップ（/）を、分離の見出し付きで返す', async () => {
  const r = await call('/test/');
  assert.equal(await r.text(), 'asset:/');
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) assert.equal(r.headers.get(k), v);
  assert.equal(r.headers.get('Cache-Control'), 'public'); // 元の見出しは残す
});

test('/test/js/app.js は /js/app.js を返す（クエリも渡す）', async () => {
  const r = await call('/test/js/reazon-worker.js?x=1');
  assert.equal(await r.text(), 'asset:/js/reazon-worker.js');
  assert.equal(r.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
});

test('/test は /test/ に転送・中の転送先は /test/ の中に直す', async () => {
  const a = await call('/test?test=1');
  assert.equal(a.status, 301);
  assert.equal(a.headers.get('Location'), 'https://example.pages.dev/test/?test=1');
  const b = await call('/test/index.html');
  assert.equal(b.headers.get('Location'), '/test/');
});
