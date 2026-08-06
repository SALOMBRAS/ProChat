package main

import (
	"encoding/binary"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// readWav lê o arquivo gerado e valida o cabeçalho canônico RIFF/WAVE.
func readWav(t *testing.T, path string) (header []byte, data []byte) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < wavHeaderSize {
		t.Fatalf("arquivo menor que o cabeçalho WAV: %d bytes", len(raw))
	}
	header, data = raw[:wavHeaderSize], raw[wavHeaderSize:]

	if string(header[0:4]) != "RIFF" || string(header[8:12]) != "WAVE" {
		t.Fatal("assinatura RIFF/WAVE ausente")
	}
	if string(header[12:16]) != "fmt " || string(header[36:40]) != "data" {
		t.Fatal("chunks fmt/data ausentes")
	}
	if got := binary.LittleEndian.Uint16(header[22:24]); got != recorderChannels {
		t.Fatalf("canais = %d, esperado %d", got, recorderChannels)
	}
	if got := binary.LittleEndian.Uint32(header[24:28]); got != recorderSampleRate {
		t.Fatalf("sample rate = %d, esperado %d", got, recorderSampleRate)
	}
	if got := binary.LittleEndian.Uint16(header[34:36]); got != recorderBitsSample {
		t.Fatalf("bits por amostra = %d, esperado %d", got, recorderBitsSample)
	}
	if got := int64(binary.LittleEndian.Uint32(header[40:44])); got != int64(len(data)) {
		t.Fatalf("data size no cabeçalho = %d, arquivo tem %d", got, len(data))
	}
	if got := int64(binary.LittleEndian.Uint32(header[4:8])); got != int64(len(raw))-8 {
		t.Fatalf("RIFF size = %d, esperado %d", got, len(raw)-8)
	}
	return header, data
}

func TestRecorderWavHeader(t *testing.T) {
	dir := t.TempDir()
	rec, err := newCallRecorder(dir, "call1", slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	rec.writeLeft([]float32{0.5, -0.5, 1.5, -1.5}) // clamp: 1.5→1, -1.5→-1
	rec.writeRight([]float32{0.25, -0.25, 0, 0})
	if err := rec.finalize(); err != nil {
		t.Fatal(err)
	}

	_, data := readWav(t, filepath.Join(dir, "call1.wav"))
	if len(data) != 4*2 { // 4 amostras mono de 2 bytes
		t.Fatalf("data = %d bytes, esperado 8", len(data))
	}
	sample := func(i int) int16 { return int16(binary.LittleEndian.Uint16(data[i*2:])) }
	// Amostra 0: mix de L=0.5 e R=0.25 → 0.375 * 32767 ≈ 12288
	if got, want := sample(0), int16(12288); got != want {
		t.Fatalf("mix[0] = %d, esperado %d", got, want)
	}
	// Amostra 1: mix de L=-0.5 e R=-0.25 → -0.375 * 32767 ≈ -12288
	if got, want := sample(1), int16(-12288); got != want {
		t.Fatalf("mix[1] = %d, esperado %d", got, want)
	}
	// Amostra 2: L clampado em 1.0 (32767), R=0 → (32767+0)/2 = 16383
	if got := sample(2); got != 16383 {
		t.Fatalf("mix[2] = %d, esperado 16383", got)
	}
	// Amostra 3: L clampado em -1.0 (-32767), R=0 → -16383 (truncado)
	if got := sample(3); got != -16383 {
		t.Fatalf("mix[3] = %d, esperado -16383", got)
	}
}

func TestRecorderUnbalancedChannels(t *testing.T) {
	dir := t.TempDir()
	rec, err := newCallRecorder(dir, "call2", slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	// Operador fala 100 amostras, contato só 40: o excedente entra no mono
	// como estava (sem dividir por 2 — é só um lado falando).
	left := make([]float32, 100)
	for i := range left {
		left[i] = 0.5
	}
	rec.writeLeft(left)
	rec.writeRight(make([]float32, 40))
	if err := rec.finalize(); err != nil {
		t.Fatal(err)
	}

	_, data := readWav(t, filepath.Join(dir, "call2.wav"))
	if len(data) != 100*2 {
		t.Fatalf("data = %d bytes, esperado %d (lado mais longo manda)", len(data), 100*2)
	}
	sample := func(i int) int16 { return int16(binary.LittleEndian.Uint16(data[i*2:])) }
	// Primeiras 40: mix com o silêncio do contato → 0.5/2 = 0.25 → 8192.
	for i := 0; i < 40; i++ {
		if got := sample(i); got != 8192 {
			t.Fatalf("mix[%d] = %d, esperado 8192", i, got)
		}
	}
	// Últimas 60: excedente do operador como estava → 0.5 → 16384.
	for i := 40; i < 100; i++ {
		if got := sample(i); got != 16384 {
			t.Fatalf("excedente[%d] = %d, esperado 16384", i, got)
		}
	}
}

func TestRecorderStreamingInterleave(t *testing.T) {
	dir := t.TempDir()
	rec, err := newCallRecorder(dir, "call3", slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	// Frames chegando alternados, como na chamada real: o recorder deve
	// mixar na ordem de chegada sem acumular o arquivo inteiro em memória.
	for i := 0; i < 10; i++ {
		rec.writeLeft([]float32{0.1})
		rec.writeRight([]float32{-0.1})
	}
	if err := rec.finalize(); err != nil {
		t.Fatal(err)
	}
	_, data := readWav(t, filepath.Join(dir, "call3.wav"))
	if len(data) != 10*2 {
		t.Fatalf("data = %d bytes, esperado 20", len(data))
	}
	// 0.1 e -0.1 se cancelam no mix.
	for i := 0; i < 10; i++ {
		if got := int16(binary.LittleEndian.Uint16(data[i*2:])); got != 0 {
			t.Fatalf("mix[%d] = %d, esperado 0", i, got)
		}
	}
}

func TestRecorderFinalizeIdempotent(t *testing.T) {
	dir := t.TempDir()
	rec, err := newCallRecorder(dir, "call4", slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	rec.writeLeft([]float32{0.5})
	rec.writeRight([]float32{0.5})
	if err := rec.finalize(); err != nil {
		t.Fatal(err)
	}
	if err := rec.finalize(); err != nil {
		t.Fatal("segundo finalize não pode falhar")
	}
	// Escritas após o finalize são ignoradas sem derrubar nada.
	rec.writeLeft([]float32{0.5})
	_, data := readWav(t, filepath.Join(dir, "call4.wav"))
	if len(data) != 2 {
		t.Fatalf("data = %d bytes após finalize, esperado 2", len(data))
	}
}

func newRecordingTestServer(t *testing.T) (*server, *Session, string) {
	t.Helper()
	mgr := newTestManager(t)
	sess := mgr.addUnconnected(t, "Rec")
	dir := t.TempDir()
	srv := &server{
		broker:        mgr.broker,
		sessions:      mgr,
		log:           slog.Default(),
		recordingsDir: dir,
	}
	return srv, sess, dir
}

func TestHandleRecordingNotFound(t *testing.T) {
	srv, sess, _ := newRecordingTestServer(t)

	req := httptest.NewRequest("GET", "/api/sessions/"+sess.id+"/calls/abc/recording", nil)
	req.SetPathValue("sid", sess.id)
	req.SetPathValue("id", "abc")
	w := httptest.NewRecorder()
	srv.handleRecording(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, esperado 404", w.Code)
	}
}

func TestHandleRecordingServesWav(t *testing.T) {
	srv, sess, dir := newRecordingTestServer(t)

	rec, err := newCallRecorder(dir, "abc", slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	rec.writeLeft([]float32{0.5})
	rec.writeRight([]float32{-0.5})
	if err := rec.finalize(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("GET", "/api/sessions/"+sess.id+"/calls/abc/recording", nil)
	req.SetPathValue("sid", sess.id)
	req.SetPathValue("id", "abc")
	w := httptest.NewRecorder()
	srv.handleRecording(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, esperado 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "audio/wav" {
		t.Fatalf("Content-Type = %q, esperado audio/wav", ct)
	}
	if body := w.Body.Bytes(); len(body) < wavHeaderSize || string(body[0:4]) != "RIFF" {
		t.Fatal("corpo da resposta não é um WAV válido")
	}
}

func TestHandleRecordingPathTraversal(t *testing.T) {
	srv, sess, _ := newRecordingTestServer(t)

	req := httptest.NewRequest("GET", "/api/sessions/"+sess.id+"/calls/..%2F..%2Fetc%2Fpasswd/recording", nil)
	req.SetPathValue("sid", sess.id)
	req.SetPathValue("id", "../../etc/passwd")
	w := httptest.NewRecorder()
	srv.handleRecording(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, esperado 404 para path traversal", w.Code)
	}
}

func TestHandleHistoryMarksRecording(t *testing.T) {
	srv, sess, dir := newRecordingTestServer(t)

	srv.broker.upsertCall(CallRecord{SessionID: sess.id, CallID: "with-rec", Direction: "outbound", Peer: "p", Status: StatusRinging})
	srv.broker.endCall("with-rec", "user-ended")
	srv.broker.upsertCall(CallRecord{SessionID: sess.id, CallID: "no-rec", Direction: "outbound", Peer: "p", Status: StatusRinging})
	srv.broker.endCall("no-rec", "user-ended")

	rec, err := newCallRecorder(dir, "with-rec", slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	rec.writeLeft([]float32{0.5})
	rec.writeRight([]float32{0.5})
	if err := rec.finalize(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("GET", "/api/sessions/"+sess.id+"/history", nil)
	req.SetPathValue("sid", sess.id)
	w := httptest.NewRecorder()
	srv.handleHistory(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, esperado 200", w.Code)
	}
	var resp struct {
		Rows []CallRecord `json:"rows"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Rows) != 2 {
		t.Fatalf("rows = %d, esperado 2", len(resp.Rows))
	}
	for _, row := range resp.Rows {
		want := row.CallID == "with-rec"
		if row.Recording != want {
			t.Fatalf("call %s: recording = %v, esperado %v", row.CallID, row.Recording, want)
		}
	}
}
