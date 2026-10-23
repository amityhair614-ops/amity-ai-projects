# Amity AI動画編集

iPhoneだけで使える、自分専用のYouTube動画編集ツールです。
iPhoneで撮影した10〜15分の美容師のカット解説動画を、AIで約10分に自動編集することを目標にしています。

## 現在の状態（v0.1 動作確認版）

- `index.html` … スマホ向けの日本語Webページ
  - 動画の選択とプレビュー（iPhone内だけで処理し、どこにも送信しません）
  - ファイル名・サイズ・長さの表示
  - 今後実装する自動編集機能の説明（すべて「準備中」）

## iPhoneで見る方法（GitHub Pages）

1. GitHubでこのリポジトリを開く
2. **Settings** → 左メニューの **Pages**
3. **Source** を「Deploy from a branch」、**Branch** を `main` / `/(root)` にして **Save**
4. 数分後に表示されるURL（`https://amityhair614-ops.github.io/amity-ai-projects/`）をiPhoneのSafariで開く

## 今後の予定

- 無音・間の自動カット
- 言い直し・NGの自動カット
- 大事なカット工程を残す判定
- 約10分への長さ調整
- 字幕の自動生成
- 書き出し・保存
