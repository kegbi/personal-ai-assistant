# ---------- build stage ----------
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* .npmrc* ./
RUN npm ci --omit=dev=false

COPY tsconfig*.json ./
COPY src ./src

RUN npm run build

# ---------- run stage ----------
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* .npmrc* ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Health-роут адаптера (опц.) слушает 8081, но в polling порты наружу не открываем
EXPOSE 8081

RUN addgroup -S app && adduser -S app -G app
USER app

CMD ["node", "dist/index.js"]
