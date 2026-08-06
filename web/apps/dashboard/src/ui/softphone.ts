import { CallsApi } from "../api/calls.js";
import { float32ToInt16LE, int16LEToFloat32 } from "./pcm.js";

/** Softphone do dashboard. Portado do cliente do WaCalls (client/src/lib/webrtc.ts):
 *  o áudio da chamada WhatsApp trafega como PCM 16 kHz por um Data Channel WebRTC
 *  entre o navegador e o Call Service (Go). A única mudança é a fronteira HTTP:
 *  em vez de bater no serviço Go direto, o SDP passa pela API do ChatPro. */

const SAMPLE_RATE = 16_000;
const PCM_CHANNEL_LABEL = "pcm";
const CAPTURE_WORKLET_URL = "/worklets/capture-processor.js";
const PLAYBACK_WORKLET_URL = "/worklets/playback-processor.js";
const CAPTURE_PROCESSOR_NAME = "capture-processor";
const PLAYBACK_PROCESSOR_NAME = "playback-processor";

export type OpenCall = {
  pc: RTCPeerConnection;
  micStream: MediaStream;
  remoteStream: MediaStream | null;
  close: () => void;
};

export const openCall = async (api: CallsApi, callId: string, micDeviceId: string | null = null): Promise<OpenCall> => {
  const micStream = await navigator.mediaDevices.getUserMedia({
    // Tratamento de voz pelo DSP nativo do navegador: supressão de ruído,
    // cancelamento de eco e ganho automático. Explícito para não depender do
    // default de cada browser.
    audio: micDeviceId
      ? { deviceId: { exact: micDeviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const pc = new RTCPeerConnection({ iceServers: [] });

  const dc = pc.createDataChannel(PCM_CHANNEL_LABEL, { ordered: true });
  dc.binaryType = "arraybuffer";

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
  await ctx.audioWorklet.addModule(PLAYBACK_WORKLET_URL);
  await ctx.resume();

  const micSource = ctx.createMediaStreamSource(micStream);
  const captureNode = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR_NAME);
  captureNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (dc.readyState === "open") dc.send(float32ToInt16LE(event.data));
  };
  micSource.connect(captureNode);
  captureNode.connect(ctx.destination);

  const playbackNode = new AudioWorkletNode(ctx, PLAYBACK_PROCESSOR_NAME);
  const streamDest = ctx.createMediaStreamDestination();
  playbackNode.connect(streamDest);
  dc.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    playbackNode.port.postMessage(int16LEToFloat32(event.data));
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") resolve();
    else {
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") resolve();
      });
    }
  });

  const { sdpAnswer } = await api.webrtc(callId, pc.localDescription!.sdp);
  await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });

  return {
    pc,
    micStream,
    remoteStream: streamDest.stream,
    close: () => {
      try { micStream.getTracks().forEach((track) => track.stop()); } catch { /* já parado */ }
      try { void ctx.close(); } catch { /* contexto já fechado */ }
      try { pc.close(); } catch { /* conexão já fechada */ }
    },
  };
};
