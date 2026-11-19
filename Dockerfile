# Kassensturz – schlankes Image ohne npm-Abhängigkeiten
FROM node:24-alpine

# su-exec: Rechte abgeben · tesseract + deutsch: Texterkennung · poppler-utils: PDF-Text und -Seitenbilder
RUN apk add --no-cache su-exec tzdata tesseract-ocr tesseract-ocr-data-deu poppler-utils \
 && tesseract --list-langs | grep -q '^deu$' && command -v pdftotext && command -v pdftoppm
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    TZ=Europe/Berlin

WORKDIR /app
COPY package.json server.js ocr.js docs.js mail.js docker-entrypoint.sh ./
COPY public ./public
RUN chmod +x docker-entrypoint.sh

# Alle Nutzdaten liegen ausschließlich hier – im Container selbst wird nichts gespeichert.
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
