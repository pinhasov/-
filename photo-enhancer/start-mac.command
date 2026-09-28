#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js לא מותקן. הורד מ- https://nodejs.org"; read -r; exit 1
fi
node serve.js
