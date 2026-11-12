// 色の扱い（元の動画の色味をそのまま残すため）。
//
// 1. 書き出す動画には、元の動画（iPhone の SDR: BT.709）と同じ色の印を付ける（outputColorSpace）。
//    canvas から書き出すと、ブラウザは「sRGB の色の印」を付ける。iPhone の写真アプリなどは、その印の動画を BT.709 に変換し直して
//    表示するため、暗く・色が薄くなった（固定テスト素材 1106: 背景が約10暗く、彩度が約0.9倍）。値はそのままで、印だけをそろえる。
// 2. iPhone の HDR 動画（HLG・BT.2020）。Safari は HDR のコマを canvas に描くとき、HDR の値のまま描く（変換しない）ため、
//    白っぽく・色が薄くなった（1106 の1本目: 彩度が約0.7倍）。HDR の素材だけ、描いた後に SDR（BT.709）へ変換する。
//    変換の明るさ（REF）は、iPhone が同じ動画を SDR に書き出したコマと比べて決めた（1106 の1本目・3コマ）。
// ブラウザが自分で変換して描くとき（パソコンの Chrome など）は、二重に変換しないよう、描いた結果を元の値と比べて確かめる。
// 計算は toneMapPixel（Node のテスト用）と、WebGL のシェーダー（書き出し用）で同じ。

export const outputColorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

// HDR の色か（HLG・PQ、または BT.2020 の色域）
export function hdrKind(cs) {
  if (!cs) return null;
  if (cs.transfer === 'hlg' || cs.transfer === 'arib-std-b67') return 'hlg';
  if (cs.transfer === 'pq' || cs.transfer === 'smpte2084') return 'pq';
  return null;
}

const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073 };
// HLG の「シーンの明るさ」を SDR の明るさにする倍率（iPhone の変換に合わせた値。基準の白 ≒ HLG の信号 0.75）
export const HLG_REF = 0.86;
const PQ_REF = 203 / 10000; // PQ は基準の白 203 cd/m²（ITU-R BT.2408）
const KNEE = 0.8; // これより明るい所は、白飛びしないようなだらかに収める
// BT.2020 → BT.709 の色の変換（光の量で）
const M2020TO709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];

function invHlg(e) {
  return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - HLG.c) / HLG.a) + HLG.b) / 12;
}
function invPq(e) {
  const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  const p = Math.pow(Math.max(e, 0), 1 / m2);
  return Math.pow(Math.max(p - c1, 0) / (c2 - c3 * p), 1 / m1);
}
function soft(x) {
  return x > KNEE ? KNEE + (1 - KNEE) * (1 - Math.exp(-(x - KNEE) / (1 - KNEE))) : x;
}
function srgbEncode(l) {
  const x = Math.min(1, Math.max(0, l));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

// HDR の値（0〜1 の R'G'B'。BT.2020 の色域）→ SDR の値（0〜1。BT.709・sRGB の canvas に描く値）
export function toneMapPixel(rgb, kind = 'hlg') {
  const lin = rgb.map(v => (kind === 'pq' ? invPq(v) / PQ_REF : invHlg(Math.min(1, Math.max(0, v))) / HLG_REF));
  return M2020TO709.map(row => srgbEncode(soft(Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]))));
}

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D img;
uniform int kind; // 0: HLG, 1: PQ
in vec2 uv;
out vec4 color;
float invHlg(float e) {
  return e <= 0.5 ? e * e / 3.0 : (exp((e - ${HLG.c}) / ${HLG.a}) + ${HLG.b}) / 12.0;
}
float invPq(float e) {
  float p = pow(max(e, 0.0), 1.0 / 78.84375);
  return pow(max(p - 0.8359375, 0.0) / (18.8515625 - 18.6875 * p), 1.0 / 0.1593017578125);
}
float soft(float x) {
  return x > ${KNEE} ? ${KNEE} + ${(1 - KNEE).toFixed(4)} * (1.0 - exp(-(x - ${KNEE}) / ${(1 - KNEE).toFixed(4)})) : x;
}
float enc(float l) {
  l = clamp(l, 0.0, 1.0);
  return l <= 0.0031308 ? 12.92 * l : 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}
void main() {
  vec4 c = texture(img, uv);
  vec3 lin = kind == 0
    ? vec3(invHlg(c.r), invHlg(c.g), invHlg(c.b)) / ${HLG_REF.toFixed(4)}
    : vec3(invPq(c.r), invPq(c.g), invPq(c.b)) / ${PQ_REF.toFixed(6)};
  mat3 m = mat3(${M2020TO709.map(r => r.join(',')).join(',')});
  vec3 l709 = max(lin * m, 0.0); // 行ごとの掛け算（GLSL の mat3 は列ごとに並ぶため、右から掛ける）
  color = vec4(enc(soft(l709.r)), enc(soft(l709.g)), enc(soft(l709.b)), 1.0);
}`;
const VERT = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() { uv = vec2((pos.x + 1.0) * 0.5, (1.0 - pos.y) * 0.5); gl_Position = vec4(pos, 0.0, 1.0); }`;

// canvas に描いた HDR の値を、SDR に変換して同じ canvas に描き戻す（WebGL2）
export class ToneMapper {
  constructor(w, h, kind) {
    this.kind = kind;
    this.canvas = new OffscreenCanvas(w, h);
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 を使えないため、HDR の動画の色を変換できません');
    this.gl = gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('色の変換の準備に失敗: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'kind'), kind === 'pq' ? 1 : 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.viewport(0, 0, w, h);
  }

  // ctx の canvas の画像を変換して、同じ ctx に描き戻す
  apply(ctx) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ctx.canvas);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.canvas, 0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }
}

// ブラウザが HDR のコマを、変換せずに（HDR の値のまま）canvas に描くか。
// コマの YUV の値を自分で RGB にした値と、canvas に描いた値を比べる。YUV を読めないときは、Safari（iPhone）なら「変換しない」とみなす
export async function drawsHdrRaw(frame) {
  try {
    const fmt = frame.format;
    if (['I420', 'I420P10', 'NV12'].includes(fmt)) {
      const w = frame.codedWidth, h = frame.codedHeight;
      const x = (Math.floor(w / 4) & ~1), y = (Math.floor(h / 4) & ~1), rw = 32, rh = 32;
      const rect = { x, y, width: rw, height: rh };
      const size = frame.allocationSize({ rect });
      const buf = fmt === 'I420P10' ? new Uint16Array(size / 2) : new Uint8Array(size);
      const layout = await frame.copyTo(buf, { rect });
      const max = fmt === 'I420P10' ? 1023 : 255;
      const full = frame.colorSpace?.fullRange;
      const cx = rw / 2, cy = rh / 2;
      const Y = buf[(layout[0].offset / (fmt === 'I420P10' ? 2 : 1)) + cy * (layout[0].stride / (fmt === 'I420P10' ? 2 : 1)) + cx] / max;
      let U, V;
      if (fmt === 'NV12') {
        const o = layout[1].offset + (cy / 2) * layout[1].stride + cx;
        U = buf[o] / max; V = buf[o + 1] / max;
      } else {
        const d = fmt === 'I420P10' ? 2 : 1;
        U = buf[layout[1].offset / d + (cy / 2) * (layout[1].stride / d) + cx / 2] / max;
        V = buf[layout[2].offset / d + (cy / 2) * (layout[2].stride / d) + cx / 2] / max;
      }
      const y1 = full ? Y : (Y - 16 / 255) * 255 / 219, u1 = (U - 0.5) * (full ? 1 : 255 / 224), v1 = (V - 0.5) * (full ? 1 : 255 / 224);
      const R = y1 + 1.4746 * v1, B = y1 + 1.8814 * u1, G = (y1 - 0.2627 * R - 0.0593 * B) / 0.678;
      const c = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      c.imageSmoothingEnabled = false;
      c.drawImage(frame, x + cx, y + cy, 1, 1, 0, 0, 1, 1);
      const px = c.getImageData(0, 0, 1, 1).data;
      const diff = Math.abs(px[0] / 255 - R) + Math.abs(px[1] / 255 - G) + Math.abs(px[2] / 255 - B);
      return { raw: diff < 0.12, how: `copyTo ${fmt} 差 ${diff.toFixed(3)}` };
    }
  } catch (err) {
    return { raw: isWebKit(), how: 'YUV を読めない（' + (err?.message || err) + '）・' + (isWebKit() ? 'Safari' : 'Safari 以外') };
  }
  return { raw: isWebKit(), how: `形式 ${frame.format}・` + (isWebKit() ? 'Safari' : 'Safari 以外') };
}

function isWebKit() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua);
}
