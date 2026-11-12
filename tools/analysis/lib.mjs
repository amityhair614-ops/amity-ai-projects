// 分析プログラムで共通に使う: 解析の結果から、アプリと同じ作り方で構成（選んだ場面）を作る
import { buildUnits, selectUnits, extendEnding, fineSpeech, bridgeSelected } from '../../js/plan.js';
import { clampPieces } from '../../js/sources.js';
import { targetRange } from '../../js/brief.js';
import { rebuildChunks } from '../../tests/reference.mjs';

export function planCuts(A, { pace, targetSec, v2 }) {
  const { duration, rmsDb, speech, motion } = A;
  const chunks = rebuildChunks(A);
  const units = buildUnits({ duration, rmsDb, speech, chunks, motion, pace, restarts: A.restarts || [] });
  const { target, max } = targetRange(targetSec);
  let sel = selectUnits(units, duration, target, max);
  if (v2) sel = bridgeSelected(sel, units, fineSpeech(rmsDb, speech.threshold), { duration, lay: A.lay });
  let shaped = extendEnding(sel, speech.voice, duration);
  if (A.lay) shaped = shaped.map(u => ({ ...u, pieces: clampPieces(u.pieces, A.lay) })).filter(u => u.pieces.length);
  return { units, sel: shaped };
}
