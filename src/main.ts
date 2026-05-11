import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import * as pg from 'pg';

// Force pg to parse TIMESTAMP WITHOUT TIME ZONE as UTC.
// By default the pg driver uses the OS local timezone (IST on dev machines),
// which causes all stored UTC timestamps to be shifted by the UTC offset.
pg.types.setTypeParser(1114, (val: string) => new Date(val + 'Z')); // TIMESTAMP
pg.types.setTypeParser(1082, (val: string) => val); // DATE — keep as string, not Date

/**
 * Application Bootstrap
 * Initializes and starts the NestJS application.
 */
async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Create the application
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // Get configuration
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') || 3000;
  const nodeEnv = configService.get<string>('nodeEnv') || 'development';

  // Raise body-parser limit so chat messages can carry up to 3 inline base64
  // images (~5 MB binary each, ~6.7 MB base64 each) plus text.
  app.use(json({ limit: '25mb' }));
  app.use(urlencoded({ extended: true, limit: '25mb' }));

  // Enable CORS
  app.enableCors({
    origin: true, // Configure properly for production
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Set global prefix for API
  app.setGlobalPrefix('api', {
    exclude: ['health', '/'],
  });

  // Swagger UI — only mount outside production. The Swagger UI and the
  // OpenAPI JSON spec leak the full API surface (routes, DTOs, schemas), so
  // they must not be reachable on a public production deployment.
  const swaggerEnabled = nodeEnv !== 'production';
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Aisle API')
      .setDescription('Aisle platform REST API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Start the server
  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);
  logger.log(`📡 Environment: ${nodeEnv}`);
  logger.log(`✅ Health check: http://localhost:${port}/health`);
  logger.log(`📚 API Base: http://localhost:${port}/api`);
  if (swaggerEnabled) {
    logger.log(`📖 Swagger UI:  http://localhost:${port}/api/docs`);
  } else {
    logger.log(`🔒 Swagger UI disabled in ${nodeEnv}`);
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
