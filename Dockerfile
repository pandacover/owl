# owl container: Node runs the TypeScript sources directly (type stripping), FFmpeg does the media work.
FROM node:22-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-inter fonts-dejavu-core fonts-noto-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src

EXPOSE 8080
CMD ["node", "src/main.ts"]
