# Vorschlag: gemeinsame Grundlage für Module mit Serverfunktionen

Stand: 1. November 2026. **Architekturentwurf, keine fertige Implementierung.**

[Ausführlicher englischer Entwurf](backend-modules.md) · [Nachricht an den Entwickler](backend-modules-discussion.md)

## Warum wir das vorschlagen

QuickShop lässt sich als Modul installieren, braucht zum dauerhaften Speichern seines Artikelkatalogs bisher aber einen eigenen Dienst. Auf einer einfachen Unraid-Installation kommen dadurch Container, Routing, Einrichtung und eine eigene Sicherung hinzu. Der erste sichtbare Effekt ist „QuickShop-Dienst nicht erreichbar“, obwohl die Modulinstallation erfolgreich war.

Für Telegram/Discord und spätere KI-Belegverarbeitung würde sich diese Einrichtungsarbeit wiederholen. Ein einfacher Modulspeicher löst den Katalog, reicht für Bots und Hintergrundverarbeitung aber nicht aus.

## Die vorgeschlagene Aufteilung

| Baustein | Aufgabe |
| --- | --- |
| Yuvomi | Anmeldung, Rechteprüfung, kleiner Modulspeicher und optional ein Zugang zu fest eingerichteten Backend-Diensten |
| Optionale Erweiterungslaufzeit | Bot-Verbindungen, geschützte Zugangsdaten und Verarbeitung im Hintergrund |
| Optionale schwere Worker | OCR, lokale Modelle oder andere rechenintensive Aufgaben |
| Moduloberfläche | Bedienung innerhalb von Yuvomi, Statusanzeige, Konfiguration und Ergebnisprüfung |

QuickShop braucht nur den ersten Baustein. Ein Telegram-/Discord-Modul benötigt zusätzlich eine Laufzeit. ReceiptScan benötigt Dateien, Aufträge und Verarbeiter; KI bleibt optional. ReceiptScan und QuickShop sollen unabhängig voneinander nutzbar bleiben.

## Was die Installation einfacher machen soll

Das Ziel lautet: Modul installieren, benötigte Fähigkeiten bewusst freigeben, gegebenenfalls Zugangsdaten eintragen und benutzen. Für mehrere Module soll eine einmal eingerichtete Laufzeit wiederverwendbar sein.

Der Browser-Installer darf dadurch nicht automatisch beliebigen heruntergeladenen Server-Code ausführen. Backend-Code braucht eine eigene Betreiberfreigabe. Bis eine solche Verwaltung existiert, müssen Voraussetzungen vor der Einrichtung sichtbar sein.

Ein einzelner angepasster Yuvomi-Container mit zusätzlichen überwachten Prozessen wäre als Versuch in unserem Fork denkbar. Das ist aber noch nicht umgesetzt und keine sichere Isolation: Prozesse mit demselben Benutzer können unter Umständen auf dieselben Dateien zugreifen. Für schwere Verarbeitung können zusätzliche Dienste weiterhin sinnvoll oder nötig sein. Wir versprechen daher keinen universellen Ein-Klick-Betrieb jedes zukünftigen Moduls.

## Was technisch geregelt werden muss

- Kleine Daten: getrennte Bereiche pro Modul, Rechteprüfung, Größenlimits und Versionsprüfung gegen versehentliches Überschreiben.
- Backend-Zugriff: nur durch den Betreiber registrierte Ziele; keine beliebigen Zieladressen aus dem Modulmanifest. Benutzer-Cookies werden nicht an Worker weitergegeben.
- Hintergrundaktionen: eigene begrenzte und widerrufbare Rechte. Ein Bot darf sich nicht einfach als Administrator ausgeben.
- Zugangsdaten: ausschließlich auf dem Server, getrennt pro Modul, keine Ausgabe im Browser oder in Protokollen. Schlüsselwechsel und Wiederherstellung müssen funktionieren.
- Dateien und Aufträge: begrenzte Uploads, dauerhafter Status, Neustartverhalten, Wiederholungen ohne doppelte Buchungen und klare Löschregeln.
- Abschalten: neue Arbeit stoppen und Hintergrundrechte sperren. Bereits an externe Anbieter übergebene Aktionen lassen sich gegebenenfalls nicht zurückholen.
- Sicherung: neben Datenbankeinträgen auch Dateien, Auftragszustände und den Wiederherstellungsweg für Geheimnisse berücksichtigen.
- KI: lokale oder externe Verarbeitung ausdrücklich wählen; Anbieter und übertragene Daten anzeigen. Ergebnisse prüfen lassen, bevor Einkaufslisten oder andere Daten verändert werden.

## Vorhandene Arbeit zuerst nutzen

In [Diskussion #746](https://github.com/ulsklyc/yuvomi/discussions/746) gibt es bereits eine [Sidecar-Plattform](https://github.com/JakeTheRabbit/yuvomi-extensions), die der Entwickler unterstützt. Ihre Eignung und Installation sollen zuerst geprüft werden. Unser Vorschlag fordert keine zweite parallele Plattform, sondern fragt nach einem kleinen Modulspeicher und einer einfacheren Einrichtung beziehungsweise Anbindung. Falls der Entwickler das bewusst außerhalb von Yuvomi halten möchte, können Verbesserungen auch dort stattfinden.

## Vorgehen

1. Mit dem Entwickler den Umfang abstimmen.
2. Den kleinen Modulspeicher als eigenen, getesteten Patch fertigstellen und QuickShop daran anbinden.
3. Einen optionalen Zugang für registrierte Backend-Dienste separat entwickeln.
4. Eine gemeinsame Laufzeit mit einem Bot und einer einfachen Datei-Verarbeitung erproben.
5. Erst danach echte OCR-/KI-Verarbeitung ergänzen.

Der vollständige Entwurf enthält API-Ideen, Sicherheitsgrenzen, konkrete Abläufe, Abnahmekriterien und offene Fragen. Er stellt die aktuellen Yuvomi-Funktionen getrennt von unseren Vorschlägen dar.

## Aktueller Stand

Dieser Branch veröffentlicht ausschließlich den Vorschlag. Die lokal begonnene Speicher-Implementierung bleibt in einem anderen Arbeitsordner. Es gibt hier noch kein fertiges Docker-Image mit dieser Plattform, keine automatische Backend-Installation und keine Zusage des Yuvomi-Entwicklers.

Die laufende Installation wird nicht geändert. Nach späteren Datenbankmigrationen ist der Rückwechsel zum offiziellen Image gesondert zu prüfen; eine Sicherung vor der Umstellung gehört zum Ablauf.
