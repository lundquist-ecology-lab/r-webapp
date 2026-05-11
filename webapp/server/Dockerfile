FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash python3 python-is-python3 make g++ pkg-config libc6-dev && \
    rm -rf /var/lib/apt/lists/*
RUN mkdir -p /home/webterm && chown 1000:1000 /home/webterm
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
