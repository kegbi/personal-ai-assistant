# ---------- build stage ----------
FROM node:24-alpine AS build
WORKDIR /app

# Install pnpm globally (no corepack)
RUN npm i -g pnpm

COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

RUN pnpm run build

# ---------- run stage ----------
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN npm i -g pnpm

COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile

COPY --from=build /app/dist ./dist

EXPOSE 3000

RUN addgroup -S app && adduser -S app -G app
USER app

CMD ["node", "dist/main.js"]
