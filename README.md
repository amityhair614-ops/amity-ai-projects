# Amity AI動画編集

iPhoneだけで使える、自分専用のYouTube動画編集ツールです。
美容師のカット解説動画から、**約60秒・縦9:16・日本語字幕付きのYouTubeショート**を自動で作ります。

## しくみ

GitHub Pages は「ファイルを置くだけ」のサーバーなので、編集処理はすべて **iPhoneのSafariの中** で行います。
動画はどこにも送信されず、追加のクラウド契約や費用はかかりません。

| 処理 | 方法 | 状態 |
| --- | --- | --- |
| 動画の読み込み | [Mediabunny](https://mediabunny.dev/)（`vendor/`）で、ファイルの必要な部分だけを読む | パソコンで確認 |
| 無音・長い間のカット | 音量（50msごと）から話している区間を検出 | パソコンで確認 |
| 言い直しの検出 | 文字起こし結果で、似た発言のくり返し・「言い直します」等を検出 | 簡易版 |
| 重要な場面を残す | 手元の動きの量（約1秒ごとのコマの差）＋美容用語で点数をつける | 簡易版 |
| 約60秒・9:16 | 点数の高い場面を時系列で並べ、動きのある位置で縦に切り抜く | パソコンで確認 |
| 日本語字幕 | 端末内のWhisper（[Transformers.js](https://huggingface.co/docs/transformers.js)）。美容用語のプロンプト＋聞き間違いの補正 | パソコンで確認（既定はOFF。失敗しても字幕なしで続行） |
| 字幕のデザイン | 白のゴシック体・最大2行・薄い影・フェード。手元に重ならない上/下に配置。言葉の途中で改行しない | パソコンで確認（書き出し時にON/OFF） |
| 自然なズーム | 手元がまとまって動く2秒以上の場面だけ、ゆっくり1.03〜1.08倍。10秒以上あけ、手元が切れる場合はしない | パソコンで確認（書き出し時にON/OFF） |
| MP4書き出し・保存 | WebCodecs（H.264/AAC）で1080×1920のMP4を作り、共有メニューから写真に保存 | パソコンで確認 |

「パソコンで確認」= パソコン上のChromeでのテストで動作確認済み。**iPhone実機では v0.3 の修正後まだ確認していません。**
iOS 26 以降の Safari が必要です。

## メモリを抑える工夫（v0.3）

iPhone の Safari はメモリが足りなくなると、エラーを出さずにページを再読み込みします（v0.2 で4K縦動画の処理中に発生）。

- ファイルは一部ずつ読む（`BlobSource` の stream reader を使わない。キャッシュ 8MB）
- 映像は自前の `VideoDecoder` で1コマずつ展開してすぐ閉じる。先読みは数コマまで
- コマは「切り抜き＋縮小」だけで canvas に描き、回転は描いた後の画像に対して行う
  （変換をかけた canvas に動画のコマを直接描くと、コマのメモリが解放されず増え続けることがあった）
- 動きの解析は 96×54 に縮小した画像で行い、書き出しは 1080×1920 固定
- 音声は少しずつ読み、文字起こし用の 16kHz モノラルだけを残す。文字起こしが終わったら手放す
- 処理中は `<video>` 要素から動画を外す
- 音声を WebCodecs で読めない場合は、区間ごとに小さな M4A に詰め直して Web Audio で読む

4K縦MOV（188MB・1分02秒）でのページのメモリのピーク（パソコンの Chrome で測定、GPU有効）:

| 段階 | v0.2 | v0.3 |
| --- | --- | --- |
| 音声の読み込み | 559MB | 265MB |
| 動きの解析 | 572MB | 391MB |
| 書き出し | 783MB | 560MB |

## 字幕AIの安定化（v0.4）

v0.3 までは字幕AIを実物で動かせていませんでした。v0.4 では Whisper（whisper-base・q8）を実際に動かして、次の問題を直しました。

- **メモリ**: 単語単位の時刻用の「注意の重み」を出力する形式のモデルだと、文字起こし中のページが約1.9GBに達した。
  出力しない形式（アプリが使う公式の onnx-community 版はこちらの形式のはず）では約0.9〜1.0GB。
  どちらの形式を読み込んだかを診断情報に記録する。重い「高精度（small）」は削除した
- **専門用語**: 「パネル→カネル」「毛先→下先」「量感→ローカー」などの誤りが多かった（文字の一致率 68%）。
  美容用語を並べたプロンプトを先に与え、よくある聞き間違いを補正して 81% に改善
- **文の区切り**: プロンプトを与えると Whisper が文ごとの時刻を出さなくなるため、
  「。」で文に分け、無音の切れ目（長い間ほど優先）に合わせて時刻を割り当てる
- **言い直し**: ひらがな表記（「いい直します」等）でも合図として検出。合図の前に内容がある文は、その文だけを除外
- 文字起こしが長引いたときに「字幕をスキップして続ける」ボタンで先に進める

## 診断情報と、途中で落ちたときの表示

処理の段階と進み具合を `localStorage` に記録しながら進めます。ページが途中で再読み込みされた場合、
次に開いたときに「前回は○○の途中で止まった」と表示します（文字起こし中に止まった場合は字幕を自動でOFFにします）。
ページ下部の「診断情報」から、端末・動画の形式・処理の記録をコピーできます（動画の中身は含みません）。

## ファイル

- `index.html` … 画面
- `js/app.js` … 画面の操作
- `js/media.js` … 動画の解析と書き出し（ブラウザ専用）
- `js/plan.js` … 無音検出・言い直し検出・場面選び・字幕の割り付け（純粋な計算だけ）
- `js/transcribe-worker.js` … 文字起こし（Whisper）
- `js/diag.js` … 診断情報・処理段階の記録
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

# iPhone の4K縦動画に近いもの（188MB・回転情報つきMOV）
python3 tests/e2e/make-sample.py /tmp/e2e 3840 2160 --duration 62 --format mov --rotate 90 --bitrate 24M
CHROME_PATH=/path/to/chrome node tests/e2e/run.mjs /tmp/e2e sample-3840x2160-r90.mov
# 失敗時の動き: --fail-asr / --no-asr / --webaudio / --reload-at=audio|asr|motion|render
# 書き出しの設定: --zoom / --no-zoom / --no-subs

# 日本語の解説音声つきのテスト動画（pyopenjtalk-plus が必要）と、本物の Whisper での確認
python3 tests/e2e/make-ja-sample.py /tmp/e2e
CHROME_PATH=/path/to/chrome node tests/e2e/run.mjs /tmp/e2e ja-sample-1920x1080-r90.mov --real-asr=/path/to/whisper-base
```

`--real-asr` は、Transformers.js・ONNX Runtime・モデルの通信を手元のファイルに差し替えて、本物の Whisper で文字起こしします
（DIR には whisper-base の `config.json` などと `onnx/encoder_model_quantized.onnx`・`onnx/decoder_model_merged_quantized.onnx` を置く）。

`--real-asr` を付けない通しテストでは、文字起こしは偽のデータに差し替えています。
H.264 を扱える Chrome（Chrome for Testing など）が必要です。Linux の Chrome は HEVC を読めないため、
HEVC の動画では「読み込めない」旨のメッセージが出ることだけを確認しています。
各段階のページのメモリのピークも表示します。

## iPhoneで見る方法（GitHub Pages）

1. GitHubでこのリポジトリを開く
2. **Settings** → 左メニューの **Pages**
3. **Source** を「Deploy from a branch」、**Branch** を `main` / `/(root)` にして **Save**
4. 数分後に表示されるURL（`https://amityhair614-ops.github.io/amity-ai-projects/`）をiPhoneのSafariで開く
