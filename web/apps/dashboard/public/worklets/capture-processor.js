// Portão de ruído (noise gate) da captura de chamadas: o Chrome já trata eco,
// supressão e ganho via constraints do getUserMedia, mas transientes — mexer no
// fone, teclado, atrito — passam. O gate corta o que fica abaixo do limiar de
// fala entre as frases, com histerese (abre num nível, fecha num mais baixo),
// sustentação de ~100 ms para não decepar o fim das palavras e fade por amostra
// para não estalar. Fala alta o bastante para abrir o portão passa intacta —
// gate não remove ruído DURANTE a fala; para isso seria RNNoise/WASM.
const OPEN_RMS = 0.012; // ~-38 dBFS: fala normal de headset fica bem acima disso
const CLOSE_RMS = 0.007; // histerese: não fica abrindo/fechando no limiar
const HOLD_BLOCKS = 13; // 13 blocos × 128 amostras a 16 kHz ≈ 104 ms de sustentação
const FADE_BLOCKS = 2; // fade de abertura/fechamento ≈ 16 ms

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.open = false;
    this.hold = 0;
    this.gain = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) return true;

    let sum = 0;
    for (let i = 0; i < channel.length; i += 1) sum += channel[i] * channel[i];
    const rms = Math.sqrt(sum / channel.length);

    if (rms >= OPEN_RMS) {
      this.open = true;
      this.hold = HOLD_BLOCKS;
    } else if (rms < CLOSE_RMS) {
      if (this.hold > 0) this.hold -= 1;
      else this.open = false;
    }
    // Entre CLOSE e OPEN com o portão aberto: mantém o estado (histerese).

    const target = this.open ? 1 : 0;
    const step = (target - this.gain) / Math.max(1, channel.length * FADE_BLOCKS);
    const out = channel.slice(0);
    for (let i = 0; i < out.length; i += 1) {
      this.gain = Math.min(1, Math.max(0, this.gain + step));
      out[i] *= this.gain;
    }
    this.port.postMessage(out);
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
