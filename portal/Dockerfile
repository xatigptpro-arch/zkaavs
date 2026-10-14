FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY store.js ./
COPY public ./public
USER 10002:10002
ENV NODE_ENV=production PORT=3600
CMD ["node", "server.js"]
