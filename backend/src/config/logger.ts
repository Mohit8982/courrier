import { createLogger, format, transports } from 'winston';
import { env } from './env';

const { combine, timestamp, errors, json, printf, colorize } = format;

const devFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level}] ${message}${metaStr}`;
});

export const logger = createLogger({
  level: env.LOG_LEVEL,
  format:
    env.NODE_ENV === 'production'
      ? combine(timestamp(), errors({ stack: true }), json())
      : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), devFormat),
  transports: [new transports.Console()],
  silent: env.NODE_ENV === 'test',
});

export default logger;
