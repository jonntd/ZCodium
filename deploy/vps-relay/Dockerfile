# ZCode VPS 中继
#
# 镜像里只放 relay 本身（单文件 + 唯一依赖 ws）。
# web bundle 走 bind mount（见 docker-compose.yml），这样换前端产物不需要重建镜像。
FROM node:22-alpine

WORKDIR /app

# relay 的唯一外部依赖。锁大版本，避免上游 breaking change 直接打进来。
RUN npm install --no-save --no-audit --no-fund ws@8

COPY relay.mjs ./

ENV PORT=3180 \
    WEB_ROOT=/app/web

EXPOSE 3180

# 用非 root 运行；bind mount 的 web/ 需要对该 uid 可读。
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3180)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "relay.mjs"]
