// テスト環境（/test/〜）: アプリと同じファイルを、クロスオリジン分離（COOP・COEP）の見出しを付けて配信する（Cloudflare Pages Functions）。
// 分離されたページでは、音声認識（ONNX Runtime）が複数のスレッドを使える。今の公開ページ（/〜）には見出しを付けない（動作は変わらない）。
// 元に戻すときは、このファイル（functions/test/）を消すだけでよい。
//   /test/            → /（index.html）
//   /test/js/app.js   → /js/app.js
export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (url.pathname === '/test') return Response.redirect(`${url.origin}/test/${url.search}`, 301);
  const rest = url.pathname.replace(/^\/test(?=\/|$)/, '') || '/';
  const res = await env.ASSETS.fetch(new Request(new URL(rest + url.search, url.origin), request));
  // 転送（/index.html → / など）は、/test/ の中の場所に直す
  const loc = res.headers.get('Location');
  const out = new Response(res.body, res);
  if (loc && loc.startsWith('/') && !loc.startsWith('/test/')) out.headers.set('Location', '/test' + loc);
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) out.headers.set(k, v);
  return out;
}
