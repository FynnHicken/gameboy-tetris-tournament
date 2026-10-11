# 🏆 Game Boy Online Multiplayer – 8-Spieler Tetris-Turnier Edition

Ein erweiterter Fork von [FynnHicken/gameboy-multiplayer](https://github.com/FynnHicken/gameboy-multiplayer) mit einem integrierten **Tetris-Turnier-Modus für bis zu 8 Spieler**, **automatischer CPU-Gegner-Auffüllung bei ungerader Spieleranzahl**, **Live-Zuschauer-Modus** und **Dual-WASM Link-Kabel CPU-Bot**.

---

## ✨ Neue Turnier-Features

- **🏆 K.O.-Turnierbaum für bis zu 8 Spieler (Viertelfinale ➔ Halbfinale ➔ Finale):**
  - Bis zu 8 Spieler im selben Party-Raum treten im K.O.-System (Best-of-1 oder Best-of-3 Herzen `♥♥`) gegeneinander an.
  - **Live-Turnierbaum (Bracket):** Echtzeit-Übersicht über alle laufenden und abgeschlossenen Matches jeder Runde inkl. Sieger-Krönung.
- **🤖 Automatische CPU-Auffüllung bei ungerader Spieleranzahl:**
  - **Ungerade Spielerzahl (`odd_plus_one`):** Bei 1, 3, 5 oder 7 Spielern wird das Teilnehmerfeld beim Start vollautomatisch mit einem **Retro-CPU-Gegner** (*R.O.B. 89*, *DMG-01 Bot*, *Tetromino Rex*, *Alexey AI*, *Pixel Byte*, *Link-Master*, *Korobeiniki*) auf eine gerade Anzahl aufgefüllt – niemand muss aussetzen!
  - **Wildcard-CPU in späteren Runden:** Entsteht in einer Folgerunde (z. B. nach 3 Viertelfinal-Matches bei 6 Spielern = 3 Halbfinalisten) erneut eine ungerade Anzahl, rückt automatisch ein Wildcard-CPU-Gegner ins Halbfinale nach, sodass jedes Match ein echtes 1v1-Duell bleibt.
  - **Voller 4er/8er Turnierbaum (`bracket_full`) & manuelle CPU-Bots:** Wahlweise kann das Turnier auch komplett auf 4 oder 8 Plätze mit CPUs aufgefüllt oder in der Lobby per **`+ 🤖 CPU hinzufügen`** beliebig ergänzt werden (auch perfekt für **Solo-Turniere gegen 3 oder 7 CPUs**!).
- **🕹️ Dual-Engine Modus (Integriertes DMG Tetris & Emulator Link-Kabel):**
  1. **Integriertes Game Boy DMG Turnier-Tetris (sofort ohne ROM spielbar):**
     - Authentische 4-Farben Game Boy DMG LCD-Grafik direkt im Game Boy Gehäuse inkl. 8-Bit *Korobeiniki (Type-A)* Chiptune-Musik.
     - Synchronisierter Zufalls-Seed (`match.seed`) pro Match: Beide Kontrahenten erhalten exakt dieselbe Tetromino-Reihenfolge.
     - **Müllzeilen-Angriffe (Garbage Lines):** Double (+1 Zeile), Triple (+2 Zeilen), Tetris (+4 Zeilen) + Combo-Bonus und Gegenangriff-Konter.
     - **Heuristische CPU-KI** in 3 Schwierigkeitsgraden (*Leicht*, *Normal*, *Stark*) + **Solo-Training gegen CPU**.
     - **👁️ Live-Zuschauer-Modus:** Ausgeschiedene oder wartende Spieler können jedes laufende Match live im Split-Screen auf ihrem Game Boy verfolgen.
  2. **Emulator Link-Kabel Modus (`tetris.gb` / `.gb` ROMs):**
     - **Isolierte Match-Link-Kabel:** Jedes 1v1-Match im Turnierbaum erhält einen eigenen dedizierten Link-Kabel-Kanal (`/ws?room=xxxx&matchId=m_r0_0&direct=1`), sodass bis zu 4 Matches (8 Spieler) gleichzeitig im selben Party-Raum über das virtuelle Link-Kabel spielen können.
     - **🤖 Dual-WASM Link-Kabel CPU-Bot:** Trifft ein Spieler im Emulator-Modus auf einen CPU-Gegner, startet im AudioWorklet automatisch ein **zweiter headless Game Boy (`WebEmulator` WASM-Instanz)**, der per virtuellem Link-Kabel gekoppelt ist und dessen Live-LCD-Bildschirm als Mini-Vorschau angezeigt wird.

---

## 🚀 Schnellstart (Docker Compose)

```bash
git clone https://github.com/FynnHicken/gameboy-tetris-tournament.git
cd gameboy-tetris-tournament

# Optional: Eigene .gb / .gbc ROMs in den Ordner ./roms legen
docker compose up -d --build
```

Oder direkt mit Node.js starten:

```bash
npm install
npm start
```

Der Server läuft anschließend auf **`http://localhost:8000`** (Docker) bzw. **`http://localhost:8080`** (Node.js).

---

## ⌨️ Steuerung (Game Boy & Turnier-Tetris)

| Aktion | Tastatur (Primär) | Alternativ |
| :--- | :--- | :--- |
| **Links / Rechts / Soft-Drop** | `A` / `D` / `S` | Pfeiltasten `←` `→` `↓` |
| **Drehen (A-Knopf)** | `W` / `J` | Pfeil hoch `↑` / `X` / `Z` |
| **Hard-Drop / B-Knopf** | `Leertaste` (`Space`) | `K` / `B` |
| **START / SELECT** | `Enter` / `Backspace` | Touch-Buttons am Gehäuse |
