FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# Static per-subject assets (the terminology glossary fallback). The KG itself
# lives only in Firestore now; test fixtures are not shipped in the image.
COPY assets ./assets
EXPOSE 8080
CMD ["node", "dist/http.js"]
