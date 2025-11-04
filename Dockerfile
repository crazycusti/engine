# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY source ./source
COPY public ./public
COPY vite.config.mjs ./vite.config.mjs
COPY jsconfig.json ./jsconfig.json

RUN npm run build:production

# Production stage
FROM node:24-alpine

ARG GIT_COMMIT_SHA
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dedicated.mjs ./dedicated.mjs
COPY --from=builder /app/dist ./dist
COPY data ./data
# still required for the dedicated server
COPY source ./source

EXPOSE 3000

CMD ["npm", "start"]
