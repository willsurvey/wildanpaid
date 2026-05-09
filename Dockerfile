FROM node:20-alpine

# Label
LABEL maintainer="radar-bursa"
LABEL description="Real-Time Smart Money Detection - Stockbit WebSocket"

# Buat direktori kerja
WORKDIR /app

# Salin dependency list dulu (Docker layer caching)
COPY package.json ./

# Install dependencies (production only, tanpa devDependencies)
RUN npm install --omit=dev && npm cache clean --force

# Salin seluruh source code
COPY . .

# Buat folder logs
RUN mkdir -p logs

# Jalankan aplikasi
CMD ["node", "src/index.js"]
