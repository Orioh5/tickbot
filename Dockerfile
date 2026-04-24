FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
