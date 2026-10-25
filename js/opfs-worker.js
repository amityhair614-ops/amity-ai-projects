// 端末内の保存領域（OPFS: Origin Private File System）へファイルを書き込む専用のワーカー。
// iPhone の Safari では、OPFS のファイルに少しずつ書く方法（createSyncAccessHandle）はワーカーの中でしか使えない
// （main スレッドで使える createWritable は Safari 26 からで、古い iOS では使えない）。
//
// メッセージ: { id, op, ... } → 返事 { id, ok, size?, error?, name? }
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

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.op === 'open') {
      const dir = await dirOf(m.path, true);
      const fh = await dir.getFileHandle(m.path[m.path.length - 1], { create: true });
      const access = await fh.createSyncAccessHandle();
      access.truncate(0);
      const h = next++;
      handles.set(h, access);
      self.postMessage({ id: m.id, ok: true, handle: h });
    } else if (m.op === 'write') {
      const access = handles.get(m.handle);
      const data = new Uint8Array(m.data);
      let done = 0;
      while (done < data.byteLength) {
        const n = access.write(data.subarray(done), { at: m.position + done });
        if (!n) throw new DOMException('書き込めませんでした（空き容量が足りない可能性があります）', 'QuotaExceededError');
        done += n;
      }
      self.postMessage({ id: m.id, ok: true });
    } else if (m.op === 'close' || m.op === 'abort') {
      const access = handles.get(m.handle);
      let size = 0;
      if (access) {
        if (m.op === 'close') { access.flush(); size = access.getSize(); }
        access.close();
        handles.delete(m.handle);
      }
      self.postMessage({ id: m.id, ok: true, size });
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, name: err && err.name, error: String(err && err.message || err) });
  }
};
