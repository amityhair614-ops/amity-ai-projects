// テストの前に、言葉の区切りの辞書（kuromoji）を読み込む（アプリは解析の前に読み込むため、テストも同じ条件にする）。
// 使い方: node --import ./tests/setup-morph.mjs --test tests/*.test.mjs（npm test）。先に npm install が必要
import { loadTokenizer } from '../js/morph.js';
await loadTokenizer();
