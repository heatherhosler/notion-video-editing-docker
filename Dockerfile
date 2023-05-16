# Build image
FROM node:18.12.0 AS builder
WORKDIR /usr/src/app
COPY . .
RUN npm ci
RUN npm run build
RUN rm -rf node_modules
RUN npm ci --production

# Production image
FROM node:18.12.0 AS runner
WORKDIR /usr/src/app
RUN apt update
RUN apt install -y ffmpeg

ENV NODE_ENV production

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/build ./build
COPY --from=builder /usr/src/app/.env ./.env

EXPOSE 8080
CMD ["node", "build/index.js"]
