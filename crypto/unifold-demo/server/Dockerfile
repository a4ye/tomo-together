FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
