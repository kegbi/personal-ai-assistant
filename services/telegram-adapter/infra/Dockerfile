# ---------- build stage ----------
FROM node:24-alpine AS build
WORKDIR /app

# Install pnpm globally (no corepack) and set config for better peer resolution
RUN npm i -g pnpm

# Copy manifest and lockfiles
COPY package.json pnpm-lock.yaml* .npmrc* ./
# Use frozen lockfile only if it exists
RUN pnpm install

COPY tsconfig*.json ./
COPY src ./src

RUN pnpm run build

# ---------- run stage ----------
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production

# Install pnpm globally (no corepack) and set config for better peer resolution
RUN npm i -g pnpm

COPY package.json pnpm-lock.yaml* .npmrc* ./
# Use frozen lockfile only if it exists
RUN pnpm install

COPY --from=build /app/dist ./dist

# Health-роут адаптера (опц.) слушает 8081, но в polling порты наружу не открываем
EXPOSE 8081

RUN addgroup -S app && adduser -S app -G app
USER app

CMD ["node", "dist/index.js"]
