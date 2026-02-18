FROM node:22-alpine

WORKDIR /app

# Instaluj 7z dla LZMA w ZIP
RUN apk add --no-cache p7zip

# Kopiuj pliki package
COPY package*.json ./

# Instaluj zależności
RUN npm install --omit=dev

# Kopiuj resztę plików
COPY . .

# Hugging Face wymaga portu 7860
ENV PORT=7860
ENV BASE_URL=""

EXPOSE 7860

# Uruchom addon
CMD ["npm", "start"]
