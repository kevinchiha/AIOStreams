import { NextFunction, Request, Response, Router } from 'express';
import {
  APIError,
  config as appConfig,
  constants,
  createLogger,
  getConfigAccessKey,
  Resource,
  StremioTransformer,
  validateConfig,
} from '@aiostreams/core';
import { corsMiddleware } from '../../middlewares/index.js';
import {
  loadKevboxTemplate,
  kevboxMembers,
  kevboxTemplatePath,
} from '../../utils/kevboxTemplate.js';
import {
  buildKevboxUserData,
  KevboxParamError,
} from '../../utils/kevboxUserData.js';
import manifest from './manifest.js';
import stream from './stream.js';
import meta from './meta.js';
import catalog from './catalog.js';
import subtitle from './subtitle.js';
import addonCatalog from './addonCatalog.js';

const logger = createLogger('server');

// Mirrors VALID_RESOURCES in middlewares/userData.ts (minus configure,
// which the kevbox router handles with its own redirect below).
const VALID_RESOURCES = [
  ...constants.RESOURCES,
  'manifest.json',
  'manifest',
  'streams',
];

interface KevboxParams {
  name?: string;
  apiKey?: string;
  [key: string]: string | string[] | undefined;
}

export const kevboxUserDataMiddleware = async (
  req: Request<KevboxParams>,
  res: Response,
  next: NextFunction
) => {
  const { name, apiKey } = req.params;

  const resourceRegex = new RegExp(`/(${VALID_RESOURCES.join('|')})`);
  const resourceMatch = req.path.match(resourceRegex);
  if (!resourceMatch) {
    next();
    return;
  }
  const resource = resourceMatch[1];

  // Same user-facing error pattern as middlewares/userData.ts: Stremio
  // resources get a playable "error stream" response, anything else an APIError.
  // The description is carried into the APIError too (manifest.json is not a
  // RESOURCE, yet it is the FIRST request a member makes on install — so the
  // specific reason, e.g. "not an allowed kevbox member", reaches them instead
  // of a generic "Invalid UUID or password").
  const respondWithError = (description: string) => {
    if (constants.RESOURCES.includes(resource as Resource)) {
      res.status(200).json(
        StremioTransformer.createDynamicError(resource as Resource, {
          errorDescription: description,
        })
      );
      return;
    }
    next(
      new APIError(
        constants.ErrorCode.USER_INVALID_DETAILS,
        undefined,
        description
      )
    );
  };

  if (!name || !apiKey) {
    respondWithError('Missing kevbox member name or API key');
    return;
  }

  if (!kevboxMembers().includes(name)) {
    logger.warn(`kevbox: rejected unknown member name "${name}"`);
    respondWithError(
      `"${name}" is not an allowed kevbox member — ask Kevin to add you`
    );
    return;
  }

  // Template-load failures (missing file, unset env var, bad JSON) get a
  // friendly error stream, never an opaque 500 — these are exactly the
  // misconfigurations a family member would otherwise hit blind.
  let template: Record<string, unknown>;
  try {
    template = loadKevboxTemplate(kevboxTemplatePath());
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`kevbox: template failed to load: ${message}`);
    respondWithError('Kevbox is misconfigured on the server — tell Kevin');
    return;
  }

  try {
    let userData = buildKevboxUserData(
      template,
      name,
      apiKey,
      appConfig.bootstrap.baseUrl,
      getConfigAccessKey()
    );
    userData = { ...userData, ip: req.userIp };

    try {
      userData = await validateConfig(userData, {
        skipErrorsFromAddonsOrProxies: true,
        decryptValues: true,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`kevbox: invalid config for member ${name}: ${message}`);
      respondWithError(message);
      return;
    }

    req.userData = userData;
    req.uuid = userData.uuid;
    logger.debug(`kevbox: serving ${resource} for member ${name}`);
    next();
  } catch (error: unknown) {
    if (error instanceof KevboxParamError) {
      respondWithError(error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`kevbox: middleware failure for member ${name}: ${message}`);
    next(new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR));
  }
};

const kevboxRouter: Router = Router({ mergeParams: true });
kevboxRouter.use(corsMiddleware);
kevboxRouter.use(kevboxUserDataMiddleware);
// SYNC NOTE: these resource mounts mirror stremioAuthRouter in app.ts. If you
// add/rename a stremio resource handler there, mirror it here (and vice versa)
// — a new resource silently 404s for kevbox members otherwise (no compile
// error). The integration test probes all six mounts to catch removals here.
kevboxRouter.use('/manifest.json', manifest);
kevboxRouter.use('/stream', stream);
kevboxRouter.use('/meta', meta);
kevboxRouter.use('/catalog', catalog);
kevboxRouter.use('/subtitles', subtitle);
kevboxRouter.use('/addon_catalog', addonCatalog);
// The shared manifest hardcodes behaviorHints.configurable: true; send
// Configure taps to the instance configure page (behind the operator login
// when AIOSTREAMS_AUTH_REQUIRED=true) instead of the :uuid router's 400.
kevboxRouter.get('/configure', (_req: Request, res: Response) => {
  res.redirect('/stremio/configure');
});

export default kevboxRouter;
