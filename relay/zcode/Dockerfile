FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
EXPOSE 18884
CMD ["node", "server.js", "--port", "18884", "--host", "0.0.0.0"]
