# Production image for the music streaming API.
# Build from repo root: docker build -f services/api/Dockerfile -t music-api .
# Run with: NODE_ENV=production, DATABASE_URL, JWT_SECRET, and provider keys.
FROM node:22-alpine AS build
WORKDIR /app
COPY services/api/package.json services/api/package-lock.json* ./services/api/
COPY package.json package-lock.json ./
WORKDIR /app/services/api
RUN npm ci --omit=dev
COPY services/api/prisma ./prisma
RUN npx prisma generate
COPY services/api/src ./src
COPY services/api/tsconfig.json ./
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/services/api/node_modules ./node_modules
COPY --from=build /app/services/api/dist ./dist
COPY --from=build /app/services/api/prisma ./prisma
COPY --from=build /app/services/api/package.json ./
# Prisma engines + migrate binary need these at runtime
RUN apk add --no-cache openssl
EXPOSE 3000
# Apply migrations, then start. Fails fast if production config is missing.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
