// カット専用モード（試作）: 字幕・BGM・ズーム・冒頭のテキストを使わず、カットだけで動画を作る。
//
// 長い動画向けに、「重要な場面を選んで残す」（selectUnits: 目標の長さに合わせて点数の低い場面から外す）のではなく、
// 「不要な部分だけを削除して、ほかは全部残す」。削除するのは、今までと同じ判定で不要とした所だけ:
//   - 言い直す前の発言・言いかけ（content.js の言い直し・くり返し、acoustic.js の音の繰り返し）
//   - つなぎ言葉だけの発言（「えー」など）
//   - 文字にならなかった短い声（2秒未満。言いよどみ・物音のことが多い。u.optional）
//   - 長すぎる間（buildUnits の間の整理。テンポ重視なら話の途中の間 0.12秒）
// 声の頭と語尾は、buildUnits の余白（PACES）で守る。複数の動画は sources.js のつなぎ方のまま。
// 既存の機能（ショート・字幕つき）は変えない。app.js が brief.mode === 'cut' のときだけ使う

// 残す場面（時刻の順）。units: buildUnits の結果
export function planRemoveOnly(units, { minDuration = 0.5 } = {}) {
  return units
    .filter(u => !u.excluded && u.duration >= minDuration)
    .filter(u => (u.kind === 'speech' ? !u.optional || u.mustKeep : !!u.mustKeep))
    .sort((a, b) => a.start - b.start);
}

// カット専用モードの理由の一覧（確認画面・診断情報用）: 削除した場面と、その理由
export function removedReasons(units, kept) {
  const k = new Set(kept.map(u => u.id));
  return units.filter(u => u.kind === 'speech' && !k.has(u.id)).map(u => ({
    start: u.start, end: u.end, text: (u.text || '').slice(0, 30),
    reason: u.excluded || (u.optional ? '文字にならなかった短い声' : u.duration < 0.5 ? '0.5秒未満' : 'その他'),
  }));
}
