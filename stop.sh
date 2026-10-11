#!/usr/bin/env bash
cd "$(dirname "$0")"
pkill -f "server.js" 2>/dev/null && echo "🛑 Server gestoppt." || echo "ℹ️ Kein laufender Server gefunden."
