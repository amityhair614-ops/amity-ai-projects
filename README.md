# Amity AI動画編集

iPhoneだけで使える、自分専用のYouTube動画編集ツールです。
美容師のカット解説動画から、**約60秒・縦9:16・日本語字幕付きのYouTubeショート**を自動で作ります。

## しくみ

GitHub Pages は「ファイルを置くだけ」のサーバーなので、編集処理はすべて **iPhoneのSafariの中** で行います。
動画はどこにも送信されず、追加のクラウド契約や費用はかかりません。

| 処理 | 方法 | 状態 |
| --- | --- | --- |
| 動画の読み込み | [Mediabunny](https://mediabunny.dev/)（`vendor/`）で端末内で読む | 使える |
| 無音・長い間のカット | 音量（50msごと）から話している区間を検出 | 使える |
| 言い直しの検出 | 文字起こし結果で、似た発言のくり返し・「言い直します」等を検出 | 簡易版 |
| 重要な場面を残す | 手元の動きの量（約1秒ごとのコマの差）＋美容用語で点数をつける | 簡易版 |
| 約60秒・9:16 | 点数の高い場面を時系列で並べ、動きのある位置で縦に切り抜く | 使える |
| 日本語字幕 | 端末内のWhisper（[Transformers.js](https://huggingface.co/docs/transformers.js)）。初回にモデルをダウンロード | 精度は限定的（書き出し前に修正可） |
| MP4書き出し・保存 | WebCodecs（H.264/AAC）でMP4を作り、共有メニューから写真に保存 | 使える |

iOS 26 以降の Safari が必要です。

## ファイル

- `index.html` … 画面
- `js/app.js` … 画面の操作
- `js/media.js` … 動画の解析と書き出し（ブラウザ専用）
- `js/plan.js` … 無音検出・言い直し検出・場面選び・字幕の割り付け（純粋な計算だけ）
- `js/transcribe-worker.js` … 文字起こし（Whisper）
- `vendor/` … Mediabunny（MPL-2.0。AACエンコーダーにFFmpegのWASM版を含む）
- `tests/` … テスト

## テスト

```sh
# 計算部分の単体テスト
node --test tests/plan.test.mjs

# 通しテスト（ブラウザで 解析→書き出し）
python3 tests/e2e/make-sample.py /tmp/e2e            # テスト用動画を作る（ffmpeg が必要）
python3 -m http.server 8123 &                        # このフォルダで起動
npm i playwright-core                                # tests/e2e から使えるように
CHROME_PATH=/path/to/chrome node tests/e2e/run.mjs /tmp/e2e
```

通しテストでは、文字起こしだけは偽のデータに差し替えています（モデルのダウンロードが必要なため）。
H.264 を扱える Chrome（Chrome for Testing など）が必要です。

## iPhoneで見る方法（GitHub Pages）

1. GitHubでこのリポジトリを開く
2. **Settings** → 左メニューの **Pages**
3. **Source** を「Deploy from a branch」、**Branch** を `main` / `/(root)` にして **Save**
4. 数分後に表示されるURL（`https://amityhair614-ops.github.io/amity-ai-projects/`）をiPhoneのSafariで開く
