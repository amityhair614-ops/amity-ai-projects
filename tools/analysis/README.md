# 分析プログラム（字幕・カットを手動編集と比べる）

同じ素材で作った **AI 編集と手動編集**、**修正前と修正後**を数字で比べるためのプログラム。
アプリの本体（`js/`）は変えない。結果は手元で見るだけで、どこにも送らない。

**リポジトリに入れないもの**: 元の動画・音声（wav）・解析の結果（`--dump-analysis` の JSON。話した言葉が入る）・
正解の文（`truth.json`。話した内容そのもの）・書き出した動画。すべて作業用のフォルダ（リポジトリの外）に置く。

## 準備

```sh
npm install                          # 字幕の辞書（kuromoji）
pip install numpy pykakasi pillow    # score.py・cutlist.py・subpages.py
pip install sherpa-onnx              # segtest.py だけ（ReazonSpeech をアプリの外で動かす）
ffmpeg -i IMG_0001.MOV -ac 1 -ar 16000 s1.wav   # 音声は 16kHz・モノラルの wav にする
```

## 流れ

1. **アプリで解析する**（本物の音声認識。PC の Chromium で、テスト環境と同じ配信）

   ```sh
   APP_URL='http://127.0.0.1:8150/test/'       # 改善版（v2）。今までの方式は '.../test/?v2=0'
   node tests/e2e/run.mjs 素材のフォルダ s1.mov,s2.mov --reazon=モデルの場所 --target=70 \
     --plan-only --dump-analysis=作業/analysis-v2.json
   ```

   書き出した動画も作るときは `--plan-only` を外す（`out-*.mp4`・`timeline-*.json` ができる）。

2. **手動編集のカットの一覧を作る**（手動編集の動画の音声が、元の動画のどこを使っているか）

   ```sh
   python3 tools/analysis/cutlist.py --sources s1.wav,s2.wav manual.wav --lay 作業/analysis-v2.json --out 作業/manual-cuts.json
   ```

3. **カットを比べる**（切りすぎた声・残しすぎ・細かいカット）

   ```sh
   node tools/analysis/cuteval.mjs 作業/analysis-v2.json 作業/manual-cuts.json --v2 --target=70 --list
   node tools/analysis/cuteval.mjs 作業/analysis-old.json 作業/manual-cuts.json --pace=natural --target=70 --list
   ```

4. **字幕を比べる**（正解の文がある素材）

   - 正解の文 `truth.json`: `[{ "id": "T1", "src": "s1", "start": 0.9, "end": 3.0, "text": "（手動編集の字幕の文）" }, …]`
     （手動編集の字幕を書き写し、元の動画の時刻を付ける。`subpages.py` で手動編集の字幕のページの時刻がわかる）
   - 文字起こしの比べ（読みで比べる・声の出始めと最初の文字の時刻の差）

     ```sh
     python3 tools/analysis/dump2chars.py 作業/analysis-v2.json 作業/v2.json s1,s2
     python3 tools/analysis/score.py truth.json 修正前=作業/old.json 修正後=作業/v2.json --wav s1=s1.wav s2=s2.wav
     ```

   - 画面に出る字幕の比べ（構成で選んだ場面の字幕だけ。抜け・聞き間違い・表示のタイミング・1文あたりのページ数）

     ```sh
     node --import ./tests/setup-morph.mjs tools/analysis/subeval.mjs 作業/analysis-v2.json truth.json --srcs=s1,s2 --v2 --list
     ```

5. **正解のない素材で、修正前・修正後を比べる**（悪化していないか）

   ```sh
   node tools/analysis/coverage.mjs 作業/analysis-old.json 作業/analysis-v2.json --list
   ```

   文字にならなかった声・声のある長い空き（文を落とした可能性）・片方にしかない言葉を出す。
   片方にしかない言葉は、どちらが正しいかを音声で確かめる。

6. **書き出した動画の字幕を見る**（AI 編集と手動編集の画面の字幕）

   ```sh
   python3 tools/analysis/subpages.py ai.mov --out 作業/pages_ai.json --sheet 作業/subs_ai
   ```

7. **区切り方の試験**（アプリの外で、区切り方だけを変えて読む）

   ```sh
   python3 tools/analysis/segtest.py --model モデルの場所 作業/seg.json s1.wav s2.wav --max 8 --join 0.3
   python3 tools/analysis/score.py truth.json 短い窓=作業/seg.json
   ```

## ファイル

| ファイル | すること |
|---|---|
| `cutlist.py` | 編集した動画の音声 → 元の動画の使った範囲（つなぎ目は 0.02秒単位） |
| `cuteval.mjs` | 自動の構成と手動編集のカットの比べ |
| `subeval.mjs` | 自動の字幕（ページ）と正解の文の比べ |
| `score.py` | 文字起こしと正解の文の比べ（読み・書き方・時刻） |
| `dump2chars.py` | 解析の結果 → score.py の形 |
| `coverage.mjs` | 正解のない素材の、修正前・修正後の比べ |
| `subpages.py` | 動画の画面の字幕のページ（時刻と切り抜き） |
| `segtest.py` | 区切り方を変えた音声認識（アプリの外） |
| `lib.mjs` | アプリと同じ作り方で構成を作る（cuteval・subeval が使う） |
