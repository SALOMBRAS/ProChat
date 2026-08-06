/** Conversão PCM do softphone: o Data Channel WebRTC carrega int16 little-endian
 *  a 16 kHz (formato do núcleo de chamadas do serviço Go); o AudioWorklet do
 *  navegador trabalha em float32. Portado do WaCalls (client/src/lib/pcm.ts). */

export const float32ToInt16LE = (pcm: Float32Array): ArrayBuffer => {
  const view = new DataView(new ArrayBuffer(pcm.length * 2));
  for (let i = 0; i < pcm.length; i += 1) {
    let s = pcm[i]!;
    if (Number.isNaN(s)) s = 0;
    else if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return view.buffer;
};

export const int16LEToFloat32 = (buf: ArrayBuffer): Float32Array => {
  const view = new DataView(buf);
  const n = Math.floor(buf.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
};
