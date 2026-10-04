FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
COPY sdk ./sdk
COPY examples ./examples
RUN npm run build
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY public ./public
COPY docs ./docs
COPY skills ./skills
COPY sdk ./sdk
COPY LICENSE THIRD_PARTY_NOTICES.md ./
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
