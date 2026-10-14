FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
RUN apt-get update && apt-get install -y --no-install-recommends tigervnc-standalone-server ca-certificates curl scrot xdotool && \
    curl -fsSLo /tmp/google-chrome.deb https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_155.0.8059.79-1_amd64.deb && \
    echo 'b7726070ca707965e9a17b38e4f15ba283bf6f65c339626c092862af7b19badc  /tmp/google-chrome.deb' | sha256sum -c - && \
    apt-get install -y --no-install-recommends /tmp/google-chrome.deb && \
    rm /tmp/google-chrome.deb && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js start.sh ./
RUN chmod +x /app/start.sh
USER 10001:10001
ENV NODE_ENV=production HOME=/profile DISPLAY=:2
CMD ["/app/start.sh"]
