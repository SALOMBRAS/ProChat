package main

import (
	"bufio"
	"encoding/binary"
	"io"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"sync"
)

const (
	// Formato fixo da gravação: WAV mono 16 kHz PCM 16-bit, com as duas
	// pontas mixadas num canal só (operador + contato), confortável em fone.
	recorderSampleRate = 16000
	recorderChannels   = 1
	recorderBitsSample = 16
	wavHeaderSize      = 44
)

// callRecorder grava o áudio das duas pontas da chamada em um WAV mono mixado:
// cada amostra gravada é clamp((operador + contato) / 2). Os lados chegam em
// frames independentes (~20 ms) em taxas parecidas; o recorder segura apenas o
// excedente de um lado até o outro chegar e mixa o par L/R conforme grava,
// mantendo o uso de memória limitado a um frame. Qualquer erro de escrita
// desabilita o recorder daquela chamada (log apenas) para nunca derrubar a
// chamada por causa da gravação.
type callRecorder struct {
	mu  sync.Mutex
	log *slog.Logger
	id  string

	f *os.File
	w *bufio.Writer

	// Amostras pendentes de cada lado aguardando o par do outro para o mix.
	left  []int16
	right []int16

	dataBytes int64 // bytes de áudio já gravados no chunk "data"
	failed    bool  // erro de escrita: gravação desta chamada desabilitada
	closed    bool
}

func newCallRecorder(dir, callID string, log *slog.Logger) (*callRecorder, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.Create(filepath.Join(dir, callID+".wav"))
	if err != nil {
		return nil, err
	}
	r := &callRecorder{log: log, id: callID, f: f, w: bufio.NewWriter(f)}
	// Cabeçalho placeholder: finalize regrava com os tamanhos reais.
	if err := writeWavHeader(r.w, 0); err != nil {
		_ = f.Close()
		return nil, err
	}
	return r, nil
}

// writeLeft grava amostras do operador (lado esquerdo do mix).
func (r *callRecorder) writeLeft(pcm []float32) {
	r.write(true, pcm)
}

// writeRight grava amostras do contato (lado direito do mix).
func (r *callRecorder) writeRight(pcm []float32) {
	r.write(false, pcm)
}

func (r *callRecorder) write(isLeft bool, pcm []float32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failed || r.closed {
		return
	}
	if isLeft {
		r.left = appendPCM16(r.left, pcm)
	} else {
		r.right = appendPCM16(r.right, pcm)
	}
	// Mixa o prefixo comum dos dois lados; o excedente fica pendente.
	n := min(len(r.left), len(r.right))
	if err := r.flushLocked(n); err != nil {
		r.failLocked(err)
	}
}

// flushLocked mixa n pares L/R em mono e grava, descartando o que foi mixado.
func (r *callRecorder) flushLocked(n int) error {
	if n == 0 {
		return nil
	}
	var buf [2]byte
	for i := 0; i < n; i++ {
		binary.LittleEndian.PutUint16(buf[:], uint16(mixInt16(r.left[i], r.right[i])))
		if _, err := r.w.Write(buf[:]); err != nil {
			return err
		}
	}
	r.left = r.left[n:]
	r.right = r.right[n:]
	r.dataBytes += int64(n * 2)
	return nil
}

// mixInt16 mixa o par operador/contato: (l + r) / 2 com clamp em int16.
func mixInt16(l, r int16) int16 {
	return clampInt16((int32(l) + int32(r)) / 2)
}

func clampInt16(v int32) int16 {
	if v > 32767 {
		return 32767
	}
	if v < -32768 {
		return -32768
	}
	return int16(v)
}

func (r *callRecorder) failLocked(err error) {
	r.failed = true
	r.log.Warn("call recording disabled after write error", "call_id", r.id, "err", err)
}

// finalize fecha o arquivo e regrava o cabeçalho WAV com os tamanhos reais.
// Se um lado tiver mais amostras que o outro, o excedente entra no mono como
// estava (sem dividir por 2 — é só um lado falando), com o mesmo clamp.
// Idempotente.
func (r *callRecorder) finalize() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	if !r.failed {
		if err := r.flushLocked(min(len(r.left), len(r.right))); err != nil {
			r.failLocked(err)
		} else if err := r.flushExcessLocked(); err != nil {
			r.failLocked(err)
		} else if err := r.w.Flush(); err != nil {
			r.failLocked(err)
		} else if _, err := r.f.Seek(0, io.SeekStart); err != nil {
			r.failLocked(err)
		} else if err := writeWavHeader(r.f, r.dataBytes); err != nil {
			r.failLocked(err)
		}
	}
	return r.f.Close()
}

// flushExcessLocked grava o excedente do lado mais longo direto no mono
// (só um lado falando: sem dividir por 2). Só um dos lados pode ter
// excedente, pois o prefixo comum já foi mixado por flushLocked.
func (r *callRecorder) flushExcessLocked() error {
	var buf [2]byte
	write := func(samples []int16) error {
		for _, s := range samples {
			binary.LittleEndian.PutUint16(buf[:], uint16(clampInt16(int32(s))))
			if _, err := r.w.Write(buf[:]); err != nil {
				return err
			}
		}
		r.dataBytes += int64(len(samples) * 2)
		return nil
	}
	if err := write(r.left); err != nil {
		return err
	}
	if err := write(r.right); err != nil {
		return err
	}
	r.left = r.left[:0]
	r.right = r.right[:0]
	return nil
}

// appendPCM16 converte float32 (-1..1, clampado) para PCM int16 little-endian.
func appendPCM16(dst []int16, pcm []float32) []int16 {
	for _, v := range pcm {
		dst = append(dst, floatToInt16(v))
	}
	return dst
}

func floatToInt16(v float32) int16 {
	v = float32(math.Max(-1, math.Min(1, float64(v))))
	return int16(math.Round(float64(v) * 32767))
}

// writeWavHeader escreve o cabeçalho canônico de 44 bytes (RIFF/WAVE PCM).
func writeWavHeader(w io.Writer, dataBytes int64) error {
	var h [wavHeaderSize]byte
	copy(h[0:4], "RIFF")
	binary.LittleEndian.PutUint32(h[4:8], uint32(36+dataBytes))
	copy(h[8:12], "WAVE")
	copy(h[12:16], "fmt ")
	binary.LittleEndian.PutUint32(h[16:20], 16) // tamanho do chunk fmt
	binary.LittleEndian.PutUint16(h[20:22], 1)  // PCM
	binary.LittleEndian.PutUint16(h[22:24], recorderChannels)
	binary.LittleEndian.PutUint32(h[24:28], recorderSampleRate)
	byteRate := uint32(recorderSampleRate * recorderChannels * recorderBitsSample / 8)
	binary.LittleEndian.PutUint32(h[28:32], byteRate)
	blockAlign := uint16(recorderChannels * recorderBitsSample / 8)
	binary.LittleEndian.PutUint16(h[32:34], blockAlign)
	binary.LittleEndian.PutUint16(h[34:36], recorderBitsSample)
	copy(h[36:40], "data")
	binary.LittleEndian.PutUint32(h[40:44], uint32(dataBytes))
	_, err := w.Write(h[:])
	return err
}
