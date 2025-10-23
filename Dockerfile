# 使用官方 Node.js 运行时作为基础镜像
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装所有依赖（包括开发依赖，用于构建）
RUN npm ci

# 复制源代码
COPY . .

# 构建应用
RUN npm run build

# 清理开发依赖，但保留 vite（服务器需要）
RUN npm prune --production
RUN npm install vite --save

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

# 创建输出目录并设置权限
# RUN mkdir -p /app/data/outputs && chown -R nextjs:nodejs /app/data/outputs

# 切换到非 root 用户
USER nextjs

# 暴露端口
EXPOSE 5174

# 启动应用
CMD ["npm", "start"]
