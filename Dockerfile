# Imagen base ligera de Node.js
FROM node:20-alpine

# Directorio de trabajo
WORKDIR /app

# Copiar definiciones de dependencias
COPY package*.json ./

# Instalar dependencias de producción
RUN npm install --omit=dev

# Copiar el código fuente
COPY . .

# Exponer el puerto por defecto (Koyeb y Render asignan PORT dinámicamente)
EXPOSE 4000
ENV PORT=4000
ENV NODE_ENV=production

# Comando de arranque
CMD ["node", "index.js"]

