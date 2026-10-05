# Agent Derby in a container.
#   docker run --rm -it -p 4747-4769:4747-4769 -v agent-derby:/data ghcr.io/osmanahmadxai/agent-derby
# then open http://localhost:4747
#
# The container is the sandbox here. Agent CLIs are installed and signed in
# INSIDE the container (use the Install and Sign in buttons); sign-ins on your
# host machine are not visible to it. For your existing sign-ins, run natively.

FROM node:22-bookworm AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm pack && mv agent-derby-*.tgz /agent-derby.tgz

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ bsdutils procps \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /agent-derby.tgz /tmp/agent-derby.tgz
RUN npm install -g --no-audit --no-fund /tmp/agent-derby.tgz && rm /tmp/agent-derby.tgz
ENV AGENT_DERBY_HOME=/data \
    AGENT_DERBY_CONTAINER=1 \
    AGENT_DERBY_HOST=0.0.0.0 \
    AGENT_DERBY_PREVIEW_PORTS=4748-4769 \
    HOME=/data/home
RUN mkdir -p /data/home
VOLUME /data
EXPOSE 4747-4769
CMD ["agent-derby", "--no-open", "--port", "4747"]
