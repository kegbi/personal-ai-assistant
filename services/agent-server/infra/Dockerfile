# ---------- build stage ----------
FROM node:24-alpine AS build
WORKDIR /app

# Install pnpm globally (no corepack)
RUN npm i -g pnpm

# Опционально: если используешь workspace (pnpm/yarn), добавь корневые lock-файлы
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile

# Копируем исходники сервиса
COPY tsconfig*.json nest-cli.json ./
COPY src ./src

# Сборка Nest в dist
RUN pnpm run build

# ---------- run stage ----------
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install pnpm globally (no corepack)
RUN npm i -g pnpm

# Добавим только prod-зависимости
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile

# Копируем сборку
COPY --from=build /app/dist ./dist

# Дженерик health endpoint будет на /health
EXPOSE 3000

# Не root-пользователь
RUN addgroup -S app && adduser -S app -G app
USER app

CMD ["node", "dist/main.js"]
