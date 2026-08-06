FROM node:24-bookworm-slim AS node-runtime

FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# The Playwright image supplies Chromium and its system dependencies, but the
# application requires Node 24 for the built-in node:sqlite module.
COPY --from=node-runtime /usr/local/ /usr/local/

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
