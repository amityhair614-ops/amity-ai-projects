# ONNX Runtime Web 1.22.0（同じものを、このサイトから配信する控え）

音声認識（js/reazon-worker.js）は、ふだんは jsDelivr（CDN）から読み込む。テスト環境で `?ort=local` を付けたときだけ、
ここのファイルを使う（CDN の見出しの都合で、クロスオリジン分離したページで読み込めない場合に比べるため）。

- 元: npm の onnxruntime-web@1.22.0 の dist/（ort.wasm.min.mjs・ort-wasm-simd-threaded.mjs・ort-wasm-simd-threaded.wasm）
- ライセンス: MIT（LICENSE.txt）
