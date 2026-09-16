/**
 * 服务入口：本地单用户工具。
 *
 * - 只监听 127.0.0.1（shared/limits.ts 的 LOCAL_HOST），端口 PORT ?? DEFAULT_PORT；
 *   不开放到局域网，也不做任何跨机访问。
 * - 启动横幅里只打印「密钥是否已配置」的布尔值，绝不打印密钥、片段或长度。
 * - 生产形态：同源托管 dist/web（由 `npm run build` 产出）；开发时由 Vite 代理 /api。
 */
import { DEFAULT_PORT, LOCAL_HOST, PROMPT_VERSION } from '../shared/limits';
import { readEnv } from './env';
import { createApp } from './routes';

function main(): void {
  const env = readEnv();
  const app = createApp();

  const server = app.listen(env.port, LOCAL_HOST, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : env.port;
    console.log(`[writing-style-lab] 服务已启动：http://${LOCAL_HOST}:${port}（仅本机可访问）`);
    console.log(
      `[writing-style-lab] 模型=${env.model} 提示词版本=${PROMPT_VERSION} 密钥已配置=${env.apiKeyConfigured ? 'yes' : 'no'} Mock=${env.mockEnabled ? 'on' : 'off'}`,
    );
    if (!env.apiKeyConfigured) {
      console.log(
        '[writing-style-lab] 未检测到 DEEPSEEK_API_KEY：/api/status 会返回 apiKeyConfigured=false，分析/归纳/试写会返回 CONFIG_MISSING_KEY；服务不会伪造任何结果。',
      );
    }
    for (const warning of env.warnings) {
      console.warn(`[writing-style-lab] 配置提醒：${warning}`);
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[writing-style-lab] 端口 ${env.port} 已被占用：请关闭占用它的进程，或用 $env:PORT=<其它端口> 重启（默认 ${DEFAULT_PORT}）。`,
      );
    } else {
      console.error(`[writing-style-lab] 启动失败：${err.name}（${err.code ?? 'unknown'}）`);
    }
    process.exitCode = 1;
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`[writing-style-lab] 收到 ${signal}，正在关闭服务…`);
    server.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
