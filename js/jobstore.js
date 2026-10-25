// 途中から再開するための保存（ブラウザ専用）。
// - 大きなデータ（元の動画のコピー・文字起こし用の音声・書き出した区間・完成したMP4）は
//   端末内の保存領域（OPFS）のファイルに、少しずつ書く（メモリに全体を持たない）
// - 進み具合と解析結果（小さなデータ）は IndexedDB に保存する（書き込みが途中で切れても壊れにくい）
//
// どちらも Safari の「履歴とWebサイトデータを消去」や、iPhone の空き容量が足りなくなったときに
// 消えることがある。必ず残るとは限らないので、元の動画は写真アプリに残しておく前提にする。

const ROOT = 'amity-jobs';

// ---------- OPFS への書き込み（ワーカー経由） ----------

let worker = null, reqId = 0;
const pending = new Map();

function rpc(msg, transfer) {
  if (!worker) {
    worker = new Worker(new URL('./opfs-worker.js', import.meta.url));
    worker.onmessage = e => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data);
      else {
        const err = new Error(e.data.error);
        err.name = e.data.name || 'Error';
        p.reject(err);
      }
    };
    worker.onerror = e => {
      for (const p of pending.values()) p.reject(new Error(e.message || '保存用のワーカーでエラーが発生しました'));
      pending.clear();
    };
  }
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}

export function isStorageFull(err) {
  return !!err && (err.name === 'QuotaExceededError' || /quota|空き容量/i.test(String(err.message)));
}

// ファイルへ書き込むための WritableStream（Mediabunny の StreamTarget に渡せる形: { data, position }）
export async function openWritable(jobId, name) {
  const { handle } = await rpc({ op: 'open', path: [ROOT, jobId, name] });
  let size = 0, closed = false;
  const stream = new WritableStream({
    async write(chunk) {
      const data = chunk.data.slice().buffer; // 元のバッファは Mediabunny が使い回すことがあるので複製して渡す
      await rpc({ op: 'write', handle, position: chunk.position, data }, [data]);
    },
    async close() {
      if (closed) return;
      closed = true;
      size = (await rpc({ op: 'close', handle })).size;
    },
    async abort() {
      if (closed) return;
      closed = true;
      await rpc({ op: 'abort', handle }).catch(() => {});
    },
  });
  // 書き出しが失敗したとき、ストリームの状態にかかわらずファイルを閉じる（閉じないと削除できない）
  const dispose = async () => {
    if (closed) return;
    closed = true;
    await rpc({ op: 'abort', handle }).catch(() => {});
  };
  return { stream, size: () => size, dispose };
}

// Blob（元の動画など）を、少しずつ読みながらファイルにコピーする
export async function copyIn(jobId, name, blob, onProgress, chunkSize = 8 * 1024 * 1024) {
  const { handle } = await rpc({ op: 'open', path: [ROOT, jobId, name] });
  try {
    for (let pos = 0; pos < blob.size; pos += chunkSize) {
      const data = await blob.slice(pos, Math.min(blob.size, pos + chunkSize)).arrayBuffer();
      await rpc({ op: 'write', handle, position: pos, data }, [data]);
      onProgress?.(Math.min(1, (pos + chunkSize) / blob.size));
    }
    return (await rpc({ op: 'close', handle })).size;
  } catch (err) {
    await rpc({ op: 'abort', handle }).catch(() => {});
    await removeFile(jobId, name);
    throw err;
  }
}

// ---------- OPFS からの読み込み・削除 ----------

async function jobDir(jobId, create = false) {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle(ROOT, { create });
  return base.getDirectoryHandle(jobId, { create });
}

// 保存したファイル（File として返す。中身はディスク上にあり、メモリには読み込まない）。なければ null
export async function readFile(jobId, name) {
  try {
    const dir = await jobDir(jobId);
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function removeFile(jobId, name) {
  try { await (await jobDir(jobId)).removeEntry(name); } catch {}
}

export async function listFiles(jobId) {
  const out = [];
  try {
    const dir = await jobDir(jobId);
    for await (const [name, h] of dir.entries()) if (h.kind === 'file') out.push({ name, size: (await h.getFile()).size });
  } catch {}
  return out;
}

export async function removeJobFiles(jobId) {
  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(ROOT);
    await base.removeEntry(jobId, { recursive: true });
  } catch {}
}

// 保存領域の使用量と上限（ブラウザが見積もった値。実際に書けるかは書いてみるまでわからない）
export async function storageInfo() {
  const info = { usage: null, quota: null, persisted: null, supported: !!navigator.storage?.getDirectory };
  try {
    const e = await navigator.storage.estimate();
    info.usage = e.usage ?? null;
    info.quota = e.quota ?? null;
  } catch {}
  try { info.persisted = await navigator.storage.persisted(); } catch {}
  return info;
}

// 保存データを消されにくくするよう、ブラウザにお願いする（認められるとは限らない）
export async function requestPersist() {
  try { return await navigator.storage.persist(); } catch { return false; }
}

// ---------- IndexedDB（進み具合・解析結果） ----------

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('amity-jobs', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('jobs', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    // 書き込みは、ディスクに書き終わってから完了とする（強制終了されても直前の保存を失わないように）
    const t = mode === 'readwrite' ? d.transaction('jobs', mode, { durability: 'strict' }) : d.transaction('jobs', mode);
    const r = fn(t.objectStore('jobs'));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('保存が中断されました'));
  }));
}

export const saveJob = job => tx('readwrite', s => s.put({ ...job, updatedAt: Date.now() }));
export const loadJob = id => tx('readonly', s => s.get(id));
export const listJobs = () => tx('readonly', s => s.getAll());
export const deleteJobRecord = id => tx('readwrite', s => s.delete(id));

export async function deleteJob(id) {
  await removeJobFiles(id);
  await deleteJobRecord(id);
}
