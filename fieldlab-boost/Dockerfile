FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY app/package.json ./
COPY app/server.js ./
COPY app/lib ./lib
COPY app/public ./public
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.js"]
