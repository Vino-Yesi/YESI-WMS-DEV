# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
WORKDIR /app

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_WMS_TENANT_CODE=YESI-FZCO
ARG VITE_WMS_DEFAULT_WAREHOUSE=DXB-FC1

ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
ENV VITE_WMS_TENANT_CODE=${VITE_WMS_TENANT_CODE}
ENV VITE_WMS_DEFAULT_WAREHOUSE=${VITE_WMS_DEFAULT_WAREHOUSE}

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY ops/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
