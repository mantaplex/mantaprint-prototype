# ==============================================================================
# MantaMan (Manta Manager) Multi-Stage Production Containerfile
# Base: Node 20 LTS Alpine (Minimal Attack Surface & Footprint)
# ==============================================================================

# Stage 1: Build Frontend SPA
FROM node:20-alpine AS frontend-builder
WORKDIR /build/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Stage 2: Production Runtime
FROM node:20-alpine AS runner
WORKDIR /opt/mantaman

ENV NODE_ENV=production
ENV MANTAMAN_PORT=8443
ENV MANTAMAN_HOST=0.0.0.0
ENV MANTAMAN_DB_PATH=/var/lib/mantaman/mantaman.sqlite

# Install minimal production utilities & dumb-init
RUN apk add --no-cache dumb-init curl

# Setup non-root system user & data directories
RUN addgroup -S mantaman && adduser -S mantaman -G mantaman && \
    mkdir -p /var/lib/mantaman /opt/mantaman/server/dist && \
    chown -R mantaman:mantaman /var/lib/mantaman /opt/mantaman

# Install server dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy server code
COPY server/ ./server/
COPY mantaprint.png ./

# Copy compiled frontend from Stage 1
COPY --from=frontend-builder /build/frontend/dist/ ./server/dist/

# Set file permissions
RUN chown -R mantaman:mantaman /opt/mantaman

USER mantaman
VOLUME ["/var/lib/mantaman"]
EXPOSE 8443 9876/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:8443/api/v1/hubs || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server/server.mjs"]
