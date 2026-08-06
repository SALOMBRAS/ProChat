// Probe de diagnóstico da Fase 0 — NÃO faz parte do WaCalls original.
// Usa a mesma sessão salva (wacalls.db) para perguntar ao WhatsApp:
//   - o número existe no WhatsApp? (IsOnWhatsApp, testando variante com/sem 9º dígito)
//   - qual o JID/LID real?
//   - quantos dispositivos o destino tem? (GetUserDevices — o que o offer de chamada usa)
// Rode com o servidor WaCalls DESLIGADO (mesma identidade + mesmo SQLite).
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"time"

	_ "modernc.org/sqlite"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func main() {
	dbPath := flag.String("db", "wacalls.db", "caminho do banco de sessão")
	phone := flag.String("phone", "", "número discado (ex.: 5585985263532)")
	flag.Parse()
	if *phone == "" {
		fmt.Println("uso: probe -db wacalls.db -phone 5585XXXXXXXXX")
		os.Exit(1)
	}

	ctx := context.Background()
	dsn := "file:" + *dbPath + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		panic(err)
	}
	db.SetMaxOpenConns(1)

	container := sqlstore.NewWithDB(db, "sqlite3", waLog.Noop)
	if err := container.Upgrade(ctx); err != nil {
		panic(err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		panic(err)
	}
	if device.ID == nil {
		fmt.Println("ERRO: nenhuma sessão pareada neste banco.")
		os.Exit(1)
	}
	fmt.Printf("Sessão encontrada: %s\n\n", device.ID.String())

	cli := whatsmeow.NewClient(device, waLog.Stdout("WA", "WARN", true))
	if err := cli.Connect(); err != nil {
		panic(err)
	}
	defer cli.Disconnect()
	time.Sleep(3 * time.Second) // dar tempo de autenticar

	if !cli.IsConnected() || !cli.IsLoggedIn() {
		fmt.Println("ERRO: não conectou/logou.")
		os.Exit(1)
	}
	fmt.Println("Conectado ao WhatsApp.")

	// Variantes: como digitado e, para celular BR com 9, a variante sem o 9.
	variants := []string{*phone}
	if len(*phone) == 13 && (*phone)[0:2] == "55" {
		variants = append(variants, (*phone)[0:4]+(*phone)[5:])
	}

	for _, v := range variants {
		fmt.Printf("\n=== Testando %s ===\n", v)
		jid := types.NewJID(v, types.DefaultUserServer)

		resp, err := cli.IsOnWhatsApp(ctx, []string{v})
		if err != nil {
			fmt.Printf("  IsOnWhatsApp erro: %v\n", err)
		} else if len(resp) == 0 {
			fmt.Println("  IsOnWhatsApp: sem resposta")
		} else {
			for _, r := range resp {
				fmt.Printf("  IsOnWhatsApp: query=%s registered=%v JID=%s\n",
					r.Query, r.IsIn, r.JID.String())
			}
		}

		devices, err := cli.GetUserDevices(ctx, []types.JID{jid})
		if err != nil {
			fmt.Printf("  GetUserDevices erro: %v\n", err)
		} else {
			fmt.Printf("  GetUserDevices: %d dispositivo(s)\n", len(devices))
			for _, d := range devices {
				fmt.Printf("    - %s\n", d.String())
			}
		}

		info, err := cli.GetUserInfo(ctx, []types.JID{jid})
		if err != nil {
			fmt.Printf("  GetUserInfo erro: %v\n", err)
		} else {
			for j, i := range info {
				fmt.Printf("  GetUserInfo: %s devices=%v status=%q lid=%s\n",
					j.String(), i.Devices, i.Status, i.LID.String())
			}
		}
	}

	fmt.Println("\nDiagnóstico concluído.")
}
