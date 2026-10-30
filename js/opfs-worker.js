// 端末内の保存領域（OPFS: Origin Private File System）へファイルを書き込む専用のワーカー。
// 書き込みの方法は2つあり、使えるほうを使う:
// 1. createSyncAccessHandle（iOS 15.2 以降。ワーカーの中だけで使える。書いた分はすぐファイルに残る）
// 2. createWritable（Safari 26 以降。閉じたときにまとめて確定する。途中で止まると、その書きかけは残らない）
// 環境によっては 1 が使えない（「この操作に対応していない」と返る）ため、そのときは 2 を使う（使い捨てのファイルで先に確かめる）。
//
// メッセージ: { id, op, ... } → 返事 { id, ok, size?, mode?, error?, name? }
//   open  { path: [フォルダ..., ファイル名] }  … 新しく作る（あれば中身を消す）
//   write { handle, position, data }          … position の位置に data を書く
//   close { handle }                          … 書いた内容を確定して閉じる
//   abort { handle }                          … 閉じる（書きかけのファイルは呼び出し側が消す）
const handles = new Map();
let next = 1;

async function dirOf(path, create) {
  let dir = await navigator.storage.getDirectory();
  for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });
  return dir;
}

// createSyncAccessHandle が使えるかを、使い捨てのファイルで一度だけ確かめる
// （対応していない環境では、失敗したファイルがそのあと書き込めなくなることがあるため、保存するファイルでは試さない）
let syncSupport = null;
async function canUseSync() {
  if (syncSupport !== null) return syncSupport;
  syncSupport = false;
  const root = await navigator.storage.getDirectory();
  const name = `.sync-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const fh = await root.getFileHandle(name, { create: true });
    if (typeof fh.createSyncAccessHandle === 'function') {
      const a = await fh.createSyncAccessHandle();
      a.close();
      syncSupport = true;
    }
  } catch {}
  await root.removeEntry(name).catch(() => {});
  return syncSupport;
}

async function openFile(dir, name) {
  const fh = await dir.getFileHandle(name, { create: true });
  if (await canUseSync()) {
    const access = await fh.createSyncAccessHandle();
    access.truncate(0);
    return { mode: 'sync', access };
  }
  if (typeof fh.createWritable !== 'function') throw new DOMException('この端末のブラウザは、端末内へのファイルの保存に対応していません', 'NotSupportedError');
  const writable = await fh.createWritable({ keepExistingData: false });
  return { mode: 'stream', writable, size: 0 };
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.op === 'open') {
      const dir = await dirOf(m.path, true);
      const h = next++;
      const f = await openFile(dir, m.path[m.path.length - 1]);
      handles.set(h, f);
      self.postMessage({ id: m.id, ok: true, handle: h, mode: f.mode });
    } else if (m.op === 'write') {
      const f = handles.get(m.handle);
      if (!f) throw new Error('ファイルが開かれていません');
      const data = new Uint8Array(m.data);
      if (f.mode === 'sync') {
        let done = 0;
        while (done < data.byteLength) {
          const n = f.access.write(data.subarray(done), { at: m.position + done });
          if (!n) throw new DOMException('書き込めませんでした（空き容量が足りない可能性があります）', 'QuotaExceededError');
          done += n;
        }
      } else {
        await f.writable.write({ type: 'write', position: m.position, data });
        f.size = Math.max(f.size, m.position + data.byteLength);
      }
      self.postMessage({ id: m.id, ok: true });
    } else if (m.op === 'close' || m.op === 'abort') {
      const f = handles.get(m.handle);
      let size = 0;
      if (f) {
        handles.delete(m.handle);
        if (f.mode === 'sync') {
          if (m.op === 'close') { f.access.flush(); size = f.access.getSize(); }
          f.access.close();
        } else if (m.op === 'close') {
          await f.writable.close();
          size = f.size;
        } else {
          await f.writable.abort().catch(() => {});
        }
      }
      self.postMessage({ id: m.id, ok: true, size });
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, name: err && err.name, error: String(err && err.message || err) });
  }
};
