import { Hono } from 'hono';
import { z } from 'zod';
import type { ConfigurationService } from './configuration.js';
import type { PlatformConfig } from './platform-config.js';
import { buildCapabilityStatus } from './capability-status.js';
import { ComputeReadinessStore } from './compute-readiness-store.js';
import type { StateFirstDB } from '@feltdb/core';

/**
 * Configuration API routes.
 * Provides GET for reading configuration and PUT for updating managed configuration.
 * Never returns secret values, only status metadata.
 */
export function configurationRoutes(
  configService: ConfigurationService,
  config: PlatformConfig,
  db?: StateFirstDB,
) {
  const app = new Hono();

  /**
   * GET /api/configuration
   * Returns the complete configuration read model with safe status indicators.
   * Never returns actual secret values.
   */
  app.get('/configuration', async (c) => {
    try {
      const configuration = await configService.getConfiguration(config);
      return c.json(configuration);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to read configuration',
        },
        500,
      );
    }
  });

  /**
   * GET /api/setup/capabilities
   * Returns capability-oriented status for the Setup UI.
   * Exposes what OpenDots can do, not implementation details.
   */
  app.get('/setup/capabilities', async (c) => {
    try {
      const configuration = await configService.getConfiguration(config);
      const computeReadiness = db ? new ComputeReadinessStore(db) : null;
      const computeState = computeReadiness
        ? await computeReadiness.current()
        : undefined;

      const capabilities = buildCapabilityStatus(configuration, computeState);
      return c.json(capabilities);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to read setup status',
        },
        500,
      );
    }
  });

  /**
   * PUT /api/configuration
   * Updates durable, non-secret configuration. Saved Intelligence settings take
   * precedence over environment bootstrap values on the next request.
   */
  app.put('/configuration', async (c) => {
    try {
      const data = z
        .object({
          intelligence: z
            .object({
              provider: z.enum(['anthropic', 'openai']).optional(),
              model: z.string().min(1).max(100).optional(),
              baseUrl: z.string().url().optional(),
            })
            // A credential field is rejected, not ignored: keys never enter
            // durable configuration.
            .strict()
            .optional(),
          browser: z
            .object({
              url: z.string().url().optional(),
              host: z.string().min(1).max(100).optional(),
              port: z.number().int().min(1).max(65535).optional(),
            })
            .optional(),
          voice: z
            .object({
              model: z.string().min(1).max(100).optional(),
              name: z.string().min(1).max(100).optional(),
            })
            .optional(),
          computers: z
            .object({
              namespace: z.string().min(1).max(100).optional(),
              memoryBytes: z.number().int().min(1).optional(),
              runtime: z.string().min(1).max(100).optional(),
              engineSocket: z.string().min(1).max(500).optional(),
            })
            .optional(),
          appOrigin: z.string().url().optional(),
        })
        .strict()
        .safeParse(await c.req.json().catch(() => null));

      if (!data.success) {
        return c.json(
          {
            error:
              'Invalid configuration format. Please check the fields and try again.',
          },
          400,
        );
      }

      await configService.saveConfiguration(data.data);
      const readModel = await configService.getConfiguration(config);

      return c.json(readModel, 200);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to save configuration',
        },
        500,
      );
    }
  });

  return app;
}
