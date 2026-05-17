# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash python3 python-is-python3 make g++ pkg-config libc6-dev tini r-base nano && \
    npm install -g node-gyp && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/users /app && \
    chown -R node:node /home/users /app
WORKDIR /app
USER node
COPY --chown=node:node package*.json ./
RUN npm install --build-from-source=node-pty
COPY --chown=node:node . .
EXPOSE 3000
CMD ["tini", "--", "node", "server.js"]
